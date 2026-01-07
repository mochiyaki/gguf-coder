import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import {PendingChange, FileChangeMessage} from './protocol';

const DIFF_SCHEME = 'coder-diff';

class DiffContentProvider implements vscode.TextDocumentContentProvider {
	private contents: Map<string, string> = new Map();
	private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
	readonly onDidChange = this._onDidChange.event;

	setContent(uri: vscode.Uri, content: string): void {
		this.contents.set(uri.toString(), content);
		this._onDidChange.fire(uri);
	}

	removeContent(uri: vscode.Uri): void {
		this.contents.delete(uri.toString());
	}

	provideTextDocumentContent(uri: vscode.Uri): string {
		return this.contents.get(uri.toString()) || '';
	}

	dispose(): void {
		this.contents.clear();
		this._onDidChange.dispose();
	}
}

export class DiffManager {
	private pendingChanges: Map<string, PendingChange> = new Map();
	private openEditors: Map<string, vscode.Uri[]> = new Map();
	private onChangeCallbacks: Set<() => void> = new Set();
	private contentProvider: DiffContentProvider;

	constructor(private context: vscode.ExtensionContext) {
		this.contentProvider = new DiffContentProvider();
		context.subscriptions.push(
			vscode.workspace.registerTextDocumentContentProvider(
				DIFF_SCHEME,
				this.contentProvider,
			),
		);
	}

	addPendingChange(message: FileChangeMessage): void {
		const change: PendingChange = {
			id: message.id,
			filePath: message.filePath,
			originalContent: message.originalContent,
			newContent: message.newContent,
			toolName: message.toolName,
			timestamp: Date.now(),
		};

		this.pendingChanges.set(message.id, change);
		this.notifyChanges();
	}

	getPendingChanges(): PendingChange[] {
		return Array.from(this.pendingChanges.values()).sort(
			(a, b) => a.timestamp - b.timestamp,
		);
	}

	getPendingChange(id: string): PendingChange | undefined {
		return this.pendingChanges.get(id);
	}

	private createVirtualUri(
		id: string,
		type: 'original' | 'modified' | 'new',
		fileName: string,
	): vscode.Uri {
		return vscode.Uri.parse(`${DIFF_SCHEME}:/${id}/${type}/${fileName}`);
	}

	async showDiff(id: string): Promise<void> {
		const change = this.pendingChanges.get(id);
		if (!change) {
			vscode.window.showErrorMessage(`Change ${id} not found`);
			return;
		}

		const activeTerminal = vscode.window.activeTerminal;
		const fileName = path.basename(change.filePath);
		const isNewFile = change.originalContent === '';

		if (isNewFile) {
			const modifiedUri = this.createVirtualUri(id, 'new', fileName);

			this.contentProvider.setContent(modifiedUri, change.newContent);

			this.openEditors.set(id, [modifiedUri]);

			const doc = await vscode.workspace.openTextDocument(modifiedUri);
			await vscode.window.showTextDocument(doc, {
				preview: true,
				preserveFocus: true,
				viewColumn: vscode.ViewColumn.Beside,
			});

			if (activeTerminal) {
				await vscode.commands.executeCommand('workbench.action.terminal.focus');
			}

			return;
		}

		const originalUri = this.createVirtualUri(id, 'original', fileName);
		const modifiedUri = this.createVirtualUri(id, 'modified', fileName);

		this.contentProvider.setContent(originalUri, change.originalContent);
		this.contentProvider.setContent(modifiedUri, change.newContent);

		this.openEditors.set(id, [originalUri, modifiedUri]);

		const title = `Coder: ${fileName} (${change.toolName})`;
		await vscode.commands.executeCommand(
			'vscode.diff',
			originalUri,
			modifiedUri,
			title,
			{preview: true},
		);

		if (activeTerminal) {
			await vscode.commands.executeCommand('workbench.action.terminal.focus');
		}
	}

	async closeDiff(id: string): Promise<void> {
		await this.closeEditors(id);
		this.removePendingChange(id);
	}

	private async closeEditors(id: string): Promise<void> {
		const uris = this.openEditors.get(id);
		if (!uris) {
			return;
		}

		const allTabs = vscode.window.tabGroups.all.flatMap(group => group.tabs);

		for (const tab of allTabs) {
			let shouldClose = false;
			const input = tab.input;

			if (input instanceof vscode.TabInputText) {
				shouldClose = uris.some(uri => uri.toString() === input.uri.toString());
			} else if (input instanceof vscode.TabInputTextDiff) {
				shouldClose =
					uris.some(uri => uri.toString() === input.original.toString()) ||
					uris.some(uri => uri.toString() === input.modified.toString());
			}

			if (shouldClose) {
				await vscode.window.tabGroups.close(tab);
			}
		}

		for (const uri of uris) {
			this.contentProvider.removeContent(uri);
		}

		this.openEditors.delete(id);
	}

	async applyChange(id: string): Promise<boolean> {
		const change = this.pendingChanges.get(id);
		if (!change) {
			vscode.window.showErrorMessage(`Change ${id} not found`);
			return false;
		}

		try {
			await this.closeEditors(id);

			const uri = vscode.Uri.file(change.filePath);
			const fileExists = fs.existsSync(change.filePath);

			if (fileExists) {
				// Open the document and apply changes
				const document = await vscode.workspace.openTextDocument(uri);
				const edit = new vscode.WorkspaceEdit();
				const fullRange = new vscode.Range(
					document.positionAt(0),
					document.positionAt(document.getText().length),
				);
				edit.replace(uri, fullRange, change.newContent);
				await vscode.workspace.applyEdit(edit);
				await document.save();
			} else {
				const dirPath = path.dirname(change.filePath);
				if (!fs.existsSync(dirPath)) {
					fs.mkdirSync(dirPath, {recursive: true});
				}
				fs.writeFileSync(change.filePath, change.newContent, 'utf-8');

				const document = await vscode.workspace.openTextDocument(uri);
				await vscode.window.showTextDocument(document);
			}

			this.removePendingChange(id);

			vscode.window.showInformationMessage(
				`Applied changes to ${path.basename(change.filePath)}`,
			);
			return true;
		} catch (error) {
			vscode.window.showErrorMessage(
				`Failed to apply changes: ${
					error instanceof Error ? error.message : error
				}`,
			);
			return false;
		}
	}

	async rejectChange(id: string): Promise<boolean> {
		const change = this.pendingChanges.get(id);
		if (!change) {
			return false;
		}

		await this.closeEditors(id);

		this.removePendingChange(id);

		vscode.window.showInformationMessage(
			`Rejected changes to ${path.basename(change.filePath)}`,
		);
		return true;
	}

	private removePendingChange(id: string): void {
		if (this.pendingChanges.has(id)) {
			this.pendingChanges.delete(id);
			this.notifyChanges();
		}
	}

	async applyAll(): Promise<void> {
		const changes = this.getPendingChanges();
		for (const change of changes) {
			await this.applyChange(change.id);
		}
	}

	rejectAll(): void {
		const ids = Array.from(this.pendingChanges.keys());
		for (const id of ids) {
			this.rejectChange(id);
		}
	}

	onChanges(callback: () => void): vscode.Disposable {
		this.onChangeCallbacks.add(callback);
		return new vscode.Disposable(() => {
			this.onChangeCallbacks.delete(callback);
		});
	}

	private notifyChanges(): void {
		this.onChangeCallbacks.forEach(callback => callback());
	}

	dispose(): void {
		this.contentProvider.dispose();
	}
}