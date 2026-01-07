/**
 * VS Code integration module
 *
 * Provides WebSocket-based communication between the coder CLI
 * and the VS Code extension for:
 * - Live diff previews
 * - File change approvals
 * - Chat integration
 * - Diagnostics sharing
 */

export {
	VSCodeServer,
	getVSCodeServer,
	isVSCodeConnected,
	sendFileChangeToVSCode,
	closeDiffInVSCode,
	closeAllDiffsInVSCode,
	type VSCodeServerCallbacks,
	type PromptHandler,
	type MessageHandler,
} from './vscode-server';

export {
	type ServerMessage,
	type ClientMessage,
	type FileChangeMessage,
	type ToolCallMessage,
	type AssistantMessage,
	type StatusMessage,
	type ConnectionAckMessage,
	type DiagnosticsRequestMessage,
	type SendPromptMessage,
	type ApplyChangeMessage,
	type RejectChangeMessage,
	type GetStatusMessage,
	type ContextMessage,
	type DiagnosticsResponseMessage,
	type DiagnosticInfo,
	type PendingChange,
	PROTOCOL_VERSION,
	DEFAULT_PORT,
} from './protocol';

export {
	isVSCodeCliAvailable,
	isExtensionInstalled,
	installExtension,
	getVsixPath,
} from './extension-installer';
