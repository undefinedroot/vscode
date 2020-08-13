/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	IUserDataSyncStoreService, IUserDataSyncLogService, IUserDataSynchroniser, SyncResource, IUserDataSyncResourceEnablementService, IUserDataSyncBackupStoreService,
	USER_DATA_SYNC_SCHEME, ISyncResourceHandle, IRemoteUserData, ISyncData, Change
} from 'vs/platform/userDataSync/common/userDataSync';
import { IEnvironmentService } from 'vs/platform/environment/common/environment';
import { IFileService, FileChangesEvent, IFileStat, IFileContent, FileOperationError, FileOperationResult } from 'vs/platform/files/common/files';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { AbstractSynchroniser, IAcceptResult, IFileResourcePreview, IMergeResult } from 'vs/platform/userDataSync/common/abstractSynchronizer';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { IStringDictionary } from 'vs/base/common/collections';
import { URI } from 'vs/base/common/uri';
import { joinPath, extname, relativePath, isEqualOrParent, basename, dirname } from 'vs/base/common/resources';
import { VSBuffer } from 'vs/base/common/buffer';
import { merge, IMergeResult as ISnippetsMergeResult, areSame } from 'vs/platform/userDataSync/common/snippetsMerge';
import { CancellationToken } from 'vs/base/common/cancellation';
import { IStorageService } from 'vs/platform/storage/common/storage';
import { deepClone } from 'vs/base/common/objects';

interface ISnippetsResourcePreview extends IFileResourcePreview {
	previewResult: IMergeResult;
}

interface ISnippetsAcceptedResourcePreview extends IFileResourcePreview {
	acceptResult: IAcceptResult;
}

export class SnippetsSynchroniser extends AbstractSynchroniser implements IUserDataSynchroniser {

	protected readonly version: number = 1;
	private readonly snippetsFolder: URI;

	constructor(
		@IEnvironmentService environmentService: IEnvironmentService,
		@IFileService fileService: IFileService,
		@IStorageService storageService: IStorageService,
		@IUserDataSyncStoreService userDataSyncStoreService: IUserDataSyncStoreService,
		@IUserDataSyncBackupStoreService userDataSyncBackupStoreService: IUserDataSyncBackupStoreService,
		@IUserDataSyncLogService logService: IUserDataSyncLogService,
		@IConfigurationService configurationService: IConfigurationService,
		@IUserDataSyncResourceEnablementService userDataSyncResourceEnablementService: IUserDataSyncResourceEnablementService,
		@ITelemetryService telemetryService: ITelemetryService,
	) {
		super(SyncResource.Snippets, fileService, environmentService, storageService, userDataSyncStoreService, userDataSyncBackupStoreService, userDataSyncResourceEnablementService, telemetryService, logService, configurationService);
		this.snippetsFolder = environmentService.snippetsHome;
		this._register(this.fileService.watch(environmentService.userRoamingDataHome));
		this._register(this.fileService.watch(this.snippetsFolder));
		this._register(this.fileService.onDidFilesChange(e => this.onFileChanges(e)));
	}

	private onFileChanges(e: FileChangesEvent): void {
		if (!e.changes.some(change => isEqualOrParent(change.resource, this.snippetsFolder))) {
			return;
		}
		this.triggerLocalChange();
	}

	protected async generateSyncPreview(remoteUserData: IRemoteUserData, lastSyncUserData: IRemoteUserData | null, token: CancellationToken): Promise<ISnippetsResourcePreview[]> {
		const local = await this.getSnippetsFileContents();
		const localSnippets = this.toSnippetsContents(local);
		const remoteSnippets: IStringDictionary<string> | null = remoteUserData.syncData ? this.parseSnippets(remoteUserData.syncData) : null;
		const lastSyncSnippets: IStringDictionary<string> | null = lastSyncUserData && lastSyncUserData.syncData ? this.parseSnippets(lastSyncUserData.syncData) : null;

		if (remoteSnippets) {
			this.logService.trace(`${this.syncResourceLogLabel}: Merging remote snippets with local snippets...`);
		} else {
			this.logService.trace(`${this.syncResourceLogLabel}: Remote snippets does not exist. Synchronizing snippets for the first time.`);
		}

		const mergeResult = merge(localSnippets, remoteSnippets, lastSyncSnippets);
		return this.getResourcePreviews(mergeResult, local, remoteSnippets || {});
	}

	protected async getMergeResult(resourcePreview: ISnippetsResourcePreview, token: CancellationToken): Promise<IMergeResult> {
		return resourcePreview.previewResult;
	}

	protected async getAcceptResult(resourcePreview: ISnippetsResourcePreview, resource: URI, content: string | null | undefined, token: CancellationToken): Promise<IAcceptResult> {

		/* Accept local resource */
		if (isEqualOrParent(resource, this.syncPreviewFolder.with({ scheme: USER_DATA_SYNC_SCHEME, authority: 'local' }))) {
			return {
				content: resourcePreview.fileContent ? resourcePreview.fileContent.value.toString() : null,
				localChange: Change.None,
				remoteChange: resourcePreview.fileContent
					? resourcePreview.remoteContent !== null ? Change.Modified : Change.Added
					: Change.Deleted
			};
		}

		/* Accept remote resource */
		if (isEqualOrParent(resource, this.syncPreviewFolder.with({ scheme: USER_DATA_SYNC_SCHEME, authority: 'remote' }))) {
			return {
				content: resourcePreview.remoteContent,
				localChange: resourcePreview.remoteContent !== null
					? resourcePreview.fileContent ? Change.Modified : Change.Added
					: Change.Deleted,
				remoteChange: Change.None,
			};
		}

		/* Accept preview resource */
		if (isEqualOrParent(resource, this.syncPreviewFolder)) {
			if (content === undefined) {
				return {
					content: resourcePreview.previewResult.content,
					localChange: resourcePreview.previewResult.localChange,
					remoteChange: resourcePreview.previewResult.remoteChange,
				};
			} else {
				return {
					content,
					localChange: content === null
						? resourcePreview.fileContent !== null ? Change.Deleted : Change.None
						: Change.Modified,
					remoteChange: content === null
						? resourcePreview.remoteContent !== null ? Change.Deleted : Change.None
						: Change.Modified
				};
			}
		}

		throw new Error(`Invalid Resource: ${resource.toString()}`);
	}

	protected async applyResult(remoteUserData: IRemoteUserData, lastSyncUserData: IRemoteUserData | null, resourcePreviews: [ISnippetsResourcePreview, IAcceptResult][], force: boolean): Promise<void> {
		const accptedResourcePreviews: ISnippetsAcceptedResourcePreview[] = resourcePreviews.map(([resourcePreview, acceptResult]) => ({ ...resourcePreview, acceptResult }));
		if (accptedResourcePreviews.every(({ localChange, remoteChange }) => localChange === Change.None && remoteChange === Change.None)) {
			this.logService.info(`${this.syncResourceLogLabel}: No changes found during synchronizing snippets.`);
		}

		if (accptedResourcePreviews.some(({ localChange }) => localChange !== Change.None)) {
			// back up all snippets
			await this.updateLocalBackup(accptedResourcePreviews);
			await this.updateLocalSnippets(accptedResourcePreviews, force);
		}

		if (accptedResourcePreviews.some(({ remoteChange }) => remoteChange !== Change.None)) {
			remoteUserData = await this.updateRemoteSnippets(accptedResourcePreviews, remoteUserData, force);
		}

		if (lastSyncUserData?.ref !== remoteUserData.ref) {
			// update last sync
			this.logService.trace(`${this.syncResourceLogLabel}: Updating last synchronized snippets...`);
			await this.updateLastSyncUserData(remoteUserData);
			this.logService.info(`${this.syncResourceLogLabel}: Updated last synchronized snippets`);
		}

		for (const { previewResource } of accptedResourcePreviews) {
			// Delete the preview
			try {
				await this.fileService.del(previewResource);
			} catch (e) { /* ignore */ }
		}

	}

	private getResourcePreviews(snippetsMergeResult: ISnippetsMergeResult, localFileContent: IStringDictionary<IFileContent>, remoteSnippets: IStringDictionary<string>): ISnippetsResourcePreview[] {
		const resourcePreviews: Map<string, ISnippetsResourcePreview> = new Map<string, ISnippetsResourcePreview>();

		/* Snippets added remotely -> add locally */
		for (const key of Object.keys(snippetsMergeResult.local.added)) {
			const previewResult: IMergeResult = {
				content: snippetsMergeResult.local.added[key],
				hasConflicts: false,
				localChange: Change.Added,
				remoteChange: Change.None,
			};
			resourcePreviews.set(key, {
				fileContent: null,
				localResource: joinPath(this.syncPreviewFolder, key).with({ scheme: USER_DATA_SYNC_SCHEME, authority: 'local' }),
				localContent: null,
				remoteResource: joinPath(this.syncPreviewFolder, key).with({ scheme: USER_DATA_SYNC_SCHEME, authority: 'remote' }),
				remoteContent: remoteSnippets[key],
				previewResource: joinPath(this.syncPreviewFolder, key),
				previewResult,
				localChange: previewResult.localChange,
				remoteChange: previewResult.remoteChange,
				acceptedResource: joinPath(this.syncPreviewFolder, key).with({ scheme: USER_DATA_SYNC_SCHEME, authority: 'accepted' })
			});
		}

		/* Snippets updated remotely -> update locally */
		for (const key of Object.keys(snippetsMergeResult.local.updated)) {
			const previewResult: IMergeResult = {
				content: snippetsMergeResult.local.updated[key],
				hasConflicts: false,
				localChange: Change.Modified,
				remoteChange: Change.None,
			};
			resourcePreviews.set(key, {
				localResource: joinPath(this.syncPreviewFolder, key).with({ scheme: USER_DATA_SYNC_SCHEME, authority: 'local' }),
				fileContent: localFileContent[key],
				localContent: localFileContent[key].value.toString(),
				remoteResource: joinPath(this.syncPreviewFolder, key).with({ scheme: USER_DATA_SYNC_SCHEME, authority: 'remote' }),
				remoteContent: remoteSnippets[key],
				previewResource: joinPath(this.syncPreviewFolder, key),
				previewResult,
				localChange: previewResult.localChange,
				remoteChange: previewResult.remoteChange,
				acceptedResource: joinPath(this.syncPreviewFolder, key).with({ scheme: USER_DATA_SYNC_SCHEME, authority: 'accepted' })
			});
		}

		/* Snippets removed remotely -> remove locally */
		for (const key of snippetsMergeResult.local.removed) {
			const previewResult: IMergeResult = {
				content: null,
				hasConflicts: false,
				localChange: Change.Deleted,
				remoteChange: Change.None,
			};
			resourcePreviews.set(key, {
				localResource: joinPath(this.syncPreviewFolder, key).with({ scheme: USER_DATA_SYNC_SCHEME, authority: 'local' }),
				fileContent: localFileContent[key],
				localContent: localFileContent[key].value.toString(),
				remoteResource: joinPath(this.syncPreviewFolder, key).with({ scheme: USER_DATA_SYNC_SCHEME, authority: 'remote' }),
				remoteContent: null,
				previewResource: joinPath(this.syncPreviewFolder, key),
				previewResult,
				localChange: previewResult.localChange,
				remoteChange: previewResult.remoteChange,
				acceptedResource: joinPath(this.syncPreviewFolder, key).with({ scheme: USER_DATA_SYNC_SCHEME, authority: 'accepted' })
			});
		}

		/* Snippets added locally -> add remotely */
		for (const key of Object.keys(snippetsMergeResult.remote.added)) {
			const previewResult: IMergeResult = {
				content: snippetsMergeResult.remote.added[key],
				hasConflicts: false,
				localChange: Change.None,
				remoteChange: Change.Added,
			};
			resourcePreviews.set(key, {
				localResource: joinPath(this.syncPreviewFolder, key).with({ scheme: USER_DATA_SYNC_SCHEME, authority: 'local' }),
				fileContent: localFileContent[key],
				localContent: localFileContent[key].value.toString(),
				remoteResource: joinPath(this.syncPreviewFolder, key).with({ scheme: USER_DATA_SYNC_SCHEME, authority: 'remote' }),
				remoteContent: null,
				previewResource: joinPath(this.syncPreviewFolder, key),
				previewResult,
				localChange: previewResult.localChange,
				remoteChange: previewResult.remoteChange,
				acceptedResource: joinPath(this.syncPreviewFolder, key).with({ scheme: USER_DATA_SYNC_SCHEME, authority: 'accepted' })
			});
		}

		/* Snippets updated locally -> update remotely */
		for (const key of Object.keys(snippetsMergeResult.remote.updated)) {
			const previewResult: IMergeResult = {
				content: snippetsMergeResult.remote.updated[key],
				hasConflicts: false,
				localChange: Change.None,
				remoteChange: Change.Modified,
			};
			resourcePreviews.set(key, {
				localResource: joinPath(this.syncPreviewFolder, key).with({ scheme: USER_DATA_SYNC_SCHEME, authority: 'local' }),
				fileContent: localFileContent[key],
				localContent: localFileContent[key].value.toString(),
				remoteResource: joinPath(this.syncPreviewFolder, key).with({ scheme: USER_DATA_SYNC_SCHEME, authority: 'remote' }),
				remoteContent: remoteSnippets[key],
				previewResource: joinPath(this.syncPreviewFolder, key),
				previewResult,
				localChange: previewResult.localChange,
				remoteChange: previewResult.remoteChange,
				acceptedResource: joinPath(this.syncPreviewFolder, key).with({ scheme: USER_DATA_SYNC_SCHEME, authority: 'accepted' })
			});
		}

		/* Snippets removed locally -> remove remotely */
		for (const key of snippetsMergeResult.remote.removed) {
			const previewResult: IMergeResult = {
				content: null,
				hasConflicts: false,
				localChange: Change.None,
				remoteChange: Change.Deleted,
			};
			resourcePreviews.set(key, {
				localResource: joinPath(this.syncPreviewFolder, key).with({ scheme: USER_DATA_SYNC_SCHEME, authority: 'local' }),
				fileContent: null,
				localContent: null,
				remoteResource: joinPath(this.syncPreviewFolder, key).with({ scheme: USER_DATA_SYNC_SCHEME, authority: 'remote' }),
				remoteContent: remoteSnippets[key],
				previewResource: joinPath(this.syncPreviewFolder, key),
				previewResult,
				localChange: previewResult.localChange,
				remoteChange: previewResult.remoteChange,
				acceptedResource: joinPath(this.syncPreviewFolder, key).with({ scheme: USER_DATA_SYNC_SCHEME, authority: 'accepted' })
			});
		}

		/* Snippets with conflicts */
		for (const key of snippetsMergeResult.conflicts) {
			const previewResult: IMergeResult = {
				content: localFileContent[key] ? localFileContent[key].value.toString() : null,
				hasConflicts: true,
				localChange: localFileContent[key] ? Change.Modified : Change.Added,
				remoteChange: remoteSnippets[key] ? Change.Modified : Change.Added
			};
			resourcePreviews.set(key, {
				localResource: joinPath(this.syncPreviewFolder, key).with({ scheme: USER_DATA_SYNC_SCHEME, authority: 'local' }),
				fileContent: localFileContent[key] || null,
				localContent: localFileContent[key] ? localFileContent[key].value.toString() : null,
				remoteResource: joinPath(this.syncPreviewFolder, key).with({ scheme: USER_DATA_SYNC_SCHEME, authority: 'remote' }),
				remoteContent: remoteSnippets[key] || null,
				previewResource: joinPath(this.syncPreviewFolder, key),
				previewResult,
				localChange: previewResult.localChange,
				remoteChange: previewResult.remoteChange,
				acceptedResource: joinPath(this.syncPreviewFolder, key).with({ scheme: USER_DATA_SYNC_SCHEME, authority: 'accepted' })
			});
		}

		/* Unmodified Snippets */
		for (const key of Object.keys(localFileContent)) {
			if (!resourcePreviews.has(key)) {
				const previewResult: IMergeResult = {
					content: localFileContent[key] ? localFileContent[key].value.toString() : null,
					hasConflicts: false,
					localChange: Change.None,
					remoteChange: Change.None
				};
				resourcePreviews.set(key, {
					localResource: joinPath(this.syncPreviewFolder, key).with({ scheme: USER_DATA_SYNC_SCHEME, authority: 'local' }),
					fileContent: localFileContent[key] || null,
					localContent: localFileContent[key] ? localFileContent[key].value.toString() : null,
					remoteResource: joinPath(this.syncPreviewFolder, key).with({ scheme: USER_DATA_SYNC_SCHEME, authority: 'remote' }),
					remoteContent: remoteSnippets[key] || null,
					previewResource: joinPath(this.syncPreviewFolder, key),
					previewResult,
					localChange: previewResult.localChange,
					remoteChange: previewResult.remoteChange,
					acceptedResource: joinPath(this.syncPreviewFolder, key).with({ scheme: USER_DATA_SYNC_SCHEME, authority: 'accepted' })
				});
			}
		}

		return [...resourcePreviews.values()];
	}

	async getAssociatedResources({ uri }: ISyncResourceHandle): Promise<{ resource: URI, comparableResource: URI }[]> {
		let content = await super.resolveContent(uri);
		if (content) {
			const syncData = this.parseSyncData(content);
			if (syncData) {
				const snippets = this.parseSnippets(syncData);
				const result = [];
				for (const snippet of Object.keys(snippets)) {
					const resource = joinPath(uri, snippet);
					const comparableResource = joinPath(this.snippetsFolder, snippet);
					const exists = await this.fileService.exists(comparableResource);
					result.push({ resource, comparableResource: exists ? comparableResource : joinPath(this.syncPreviewFolder, snippet).with({ scheme: USER_DATA_SYNC_SCHEME, authority: 'local' }) });
				}
				return result;
			}
		}
		return [];
	}

	async resolveContent(uri: URI): Promise<string | null> {
		if (isEqualOrParent(uri, this.syncPreviewFolder.with({ scheme: USER_DATA_SYNC_SCHEME, authority: 'remote' }))
			|| isEqualOrParent(uri, this.syncPreviewFolder.with({ scheme: USER_DATA_SYNC_SCHEME, authority: 'local' }))
			|| isEqualOrParent(uri, this.syncPreviewFolder.with({ scheme: USER_DATA_SYNC_SCHEME, authority: 'accepted' }))) {
			return this.resolvePreviewContent(uri);
		}

		let content = await super.resolveContent(uri);
		if (content) {
			return content;
		}

		content = await super.resolveContent(dirname(uri));
		if (content) {
			const syncData = this.parseSyncData(content);
			if (syncData) {
				const snippets = this.parseSnippets(syncData);
				return snippets[basename(uri)] || null;
			}
		}

		return null;
	}

	async hasLocalData(): Promise<boolean> {
		try {
			const localSnippets = await this.getSnippetsFileContents();
			if (Object.keys(localSnippets).length) {
				return true;
			}
		} catch (error) {
			/* ignore error */
		}
		return false;
	}

	private async updateLocalBackup(resourcePreviews: IFileResourcePreview[]): Promise<void> {
		const local: IStringDictionary<IFileContent> = {};
		for (const resourcePreview of resourcePreviews) {
			if (resourcePreview.fileContent) {
				local[basename(resourcePreview.localResource!)] = resourcePreview.fileContent;
			}
		}
		await this.backupLocal(JSON.stringify(this.toSnippetsContents(local)));
	}

	private async updateLocalSnippets(resourcePreviews: ISnippetsAcceptedResourcePreview[], force: boolean): Promise<void> {
		for (const { fileContent, acceptResult, localResource, remoteResource, localChange } of resourcePreviews) {
			if (localChange !== Change.None) {
				const key = remoteResource ? basename(remoteResource) : basename(localResource!);
				const resource = joinPath(this.snippetsFolder, key);

				// Removed
				if (localChange === Change.Deleted) {
					this.logService.trace(`${this.syncResourceLogLabel}: Deleting snippet...`, basename(resource));
					await this.fileService.del(resource);
					this.logService.info(`${this.syncResourceLogLabel}: Deleted snippet`, basename(resource));
				}

				// Added
				else if (localChange === Change.Added) {
					this.logService.trace(`${this.syncResourceLogLabel}: Creating snippet...`, basename(resource));
					await this.fileService.createFile(resource, VSBuffer.fromString(acceptResult.content!), { overwrite: force });
					this.logService.info(`${this.syncResourceLogLabel}: Created snippet`, basename(resource));
				}

				// Updated
				else {
					this.logService.trace(`${this.syncResourceLogLabel}: Updating snippet...`, basename(resource));
					await this.fileService.writeFile(resource, VSBuffer.fromString(acceptResult.content!), force ? undefined : fileContent!);
					this.logService.info(`${this.syncResourceLogLabel}: Updated snippet`, basename(resource));
				}
			}
		}
	}

	private async updateRemoteSnippets(resourcePreviews: ISnippetsAcceptedResourcePreview[], remoteUserData: IRemoteUserData, forcePush: boolean): Promise<IRemoteUserData> {
		const currentSnippets: IStringDictionary<string> = remoteUserData.syncData ? this.parseSnippets(remoteUserData.syncData) : {};
		const newSnippets: IStringDictionary<string> = deepClone(currentSnippets);

		for (const { acceptResult, localResource, remoteResource, remoteChange } of resourcePreviews) {
			if (remoteChange !== Change.None) {
				const key = localResource ? basename(localResource) : basename(remoteResource!);
				if (remoteChange === Change.Deleted) {
					delete newSnippets[key];
				} else {
					newSnippets[key] = acceptResult.content!;
				}
			}
		}

		if (!areSame(currentSnippets, newSnippets)) {
			// update remote
			this.logService.trace(`${this.syncResourceLogLabel}: Updating remote snippets...`);
			remoteUserData = await this.updateRemoteUserData(JSON.stringify(newSnippets), forcePush ? null : remoteUserData.ref);
			this.logService.info(`${this.syncResourceLogLabel}: Updated remote snippets`);
		}
		return remoteUserData;
	}

	private parseSnippets(syncData: ISyncData): IStringDictionary<string> {
		return JSON.parse(syncData.content);
	}

	private toSnippetsContents(snippetsFileContents: IStringDictionary<IFileContent>): IStringDictionary<string> {
		const snippets: IStringDictionary<string> = {};
		for (const key of Object.keys(snippetsFileContents)) {
			snippets[key] = snippetsFileContents[key].value.toString();
		}
		return snippets;
	}

	private async getSnippetsFileContents(): Promise<IStringDictionary<IFileContent>> {
		const snippets: IStringDictionary<IFileContent> = {};
		let stat: IFileStat;
		try {
			stat = await this.fileService.resolve(this.snippetsFolder);
		} catch (e) {
			// No snippets
			if (e instanceof FileOperationError && e.fileOperationResult === FileOperationResult.FILE_NOT_FOUND) {
				return snippets;
			} else {
				throw e;
			}
		}
		for (const entry of stat.children || []) {
			const resource = entry.resource;
			const extension = extname(resource);
			if (extension === '.json' || extension === '.code-snippets') {
				const key = relativePath(this.snippetsFolder, resource)!;
				const content = await this.fileService.readFile(resource);
				snippets[key] = content;
			}
		}
		return snippets;
	}
}
