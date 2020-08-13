#!/usr/bin/env node

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @ts-check

const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');
const util = require('util');
const opn = require('opn');
const minimist = require('minimist');
const fancyLog = require('fancy-log');
const ansiColors = require('ansi-colors');

const extensions = require('../../build/lib/extensions');

const APP_ROOT = path.join(__dirname, '..', '..');
const BUILTIN_EXTENSIONS_ROOT = path.join(APP_ROOT, 'extensions');
const BUILTIN_MARKETPLACE_EXTENSIONS_ROOT = path.join(APP_ROOT, '.build', 'builtInExtensions');
const WEB_MAIN = path.join(APP_ROOT, 'src', 'vs', 'code', 'browser', 'workbench', 'workbench-dev.html');

const args = minimist(process.argv, {
	boolean: [
		'no-launch',
		'help',
		'verbose',
		'wrap-iframe'
	],
	string: [
		'scheme',
		'host',
		'port',
		'local_port',
		'extension'
	],
});

if (args.help) {
	console.log(
		'yarn web [options]\n' +
		' --no-launch      Do not open VSCode web in the browser\n' +
		' --wrap-iframe    Wrap the Web Worker Extension Host in an iframe\n' +
		' --scheme         Protocol (https or http)\n' +
		' --host           Remote host\n' +
		' --port           Remote/Local port\n' +
		' --local_port     Local port override\n' +
		' --extension      Path of an extension to include\n' +
		' --verbose        Print out more information\n' +
		' --help\n' +
		'[Example]\n' +
		' yarn web --scheme https --host example.com --port 8080 --local_port 30000'
	);
	process.exit(0);
}

const PORT = args.port || process.env.PORT || 8080;
const LOCAL_PORT = args.local_port || process.env.LOCAL_PORT || PORT;
const SCHEME = args.scheme || process.env.VSCODE_SCHEME || 'http';
const HOST = args.host || 'localhost';
const AUTHORITY = process.env.VSCODE_AUTHORITY || `${HOST}:${PORT}`;

const exists = (path) => util.promisify(fs.exists)(path);
const readFile = (path) => util.promisify(fs.readFile)(path);

async function getBuiltInExtensionInfos() {
	const allExtensions = [];
	/** @type {Object.<string, string>} */
	const locations = {};

	const [localExtensions, marketplaceExtensions] = await Promise.all([
		extensions.scanBuiltinExtensions(BUILTIN_EXTENSIONS_ROOT),
		extensions.scanBuiltinExtensions(BUILTIN_MARKETPLACE_EXTENSIONS_ROOT),
	]);
	for (const ext of localExtensions) {
		allExtensions.push(ext);
		locations[ext.extensionPath] = path.join(BUILTIN_EXTENSIONS_ROOT, ext.extensionPath);
	}
	for (const ext of marketplaceExtensions) {
		allExtensions.push(ext);
		locations[ext.extensionPath] = path.join(BUILTIN_MARKETPLACE_EXTENSIONS_ROOT, ext.extensionPath);
	}
	for (const ext of allExtensions) {
		if (ext.packageJSON.browser) {
			let mainFilePath = path.join(locations[ext.extensionPath], ext.packageJSON.browser);
			if (path.extname(mainFilePath) !== '.js') {
				mainFilePath += '.js';
			}
			if (!await exists(mainFilePath)) {
				fancyLog(`${ansiColors.red('Error')}: Could not find ${mainFilePath}. Use ${ansiColors.cyan('yarn watch-web')} to build the built-in extensions.`);
			}
		}
	}
	return { extensions: allExtensions, locations };
}

async function getDefaultExtensionInfos() {
	const extensions = [];

	/** @type {Object.<string, string>} */
	const locations = {};

	let extensionArg = args['extension'];
	if (!extensionArg) {
		return { extensions, locations };
	}

	const extensionPaths = Array.isArray(extensionArg) ? extensionArg : [extensionArg];
	await Promise.all(extensionPaths.map(async extensionPath => {
		extensionPath = path.resolve(process.cwd(), extensionPath);
		const packageJSON = await getExtensionPackageJSON(extensionPath);
		if (packageJSON) {
			const extensionId = `${packageJSON.publisher}.${packageJSON.name}`;
			extensions.push({
				packageJSON,
				extensionLocation: { scheme: SCHEME, authority: AUTHORITY, path: `/extension/${extensionId}` }
			});
			locations[extensionId] = extensionPath;
		}
	}));
	return { extensions, locations };
}

async function getExtensionPackageJSON(extensionPath) {

	const packageJSONPath = path.join(extensionPath, 'package.json');
	if (await exists(packageJSONPath)) {
		try {
			let packageJSON = JSON.parse((await readFile(packageJSONPath)).toString());
			if (packageJSON.main && !packageJSON.browser) {
				return; // unsupported
			}

			const packageNLSPath = path.join(extensionPath, 'package.nls.json');
			const packageNLSExists = await exists(packageNLSPath);
			if (packageNLSExists) {
				packageJSON = extensions.translatePackageJSON(packageJSON, packageNLSPath); // temporary, until fixed in core
			}

			return packageJSON;
		} catch (e) {
			console.log(e);
		}
	}
	return undefined;
}

const builtInExtensionsPromise = getBuiltInExtensionInfos();
const defaultExtensionsPromise = getDefaultExtensionInfos();

const mapCallbackUriToRequestId = new Map();

const server = http.createServer((req, res) => {
	const parsedUrl = url.parse(req.url, true);
	const pathname = parsedUrl.pathname;

	try {
		if (pathname === '/favicon.ico') {
			// favicon
			return serveFile(req, res, path.join(APP_ROOT, 'resources', 'win32', 'code.ico'));
		}
		if (pathname === '/manifest.json') {
			// manifest
			res.writeHead(200, { 'Content-Type': 'application/json' });
			return res.end(JSON.stringify({
				'name': 'Code Web - OSS',
				'short_name': 'Code Web - OSS',
				'start_url': '/',
				'lang': 'en-US',
				'display': 'standalone'
			}));
		}
		if (/^\/static\//.test(pathname)) {
			// static requests
			return handleStatic(req, res, parsedUrl);
		}
		if (/^\/extension\//.test(pathname)) {
			// default extension requests
			return handleExtension(req, res, parsedUrl);
		}
		if (pathname === '/') {
			// main web
			return handleRoot(req, res);
		} else if (pathname === '/callback') {
			// callback support
			return handleCallback(req, res, parsedUrl);
		} else if (pathname === '/fetch-callback') {
			// callback fetch support
			return handleFetchCallback(req, res, parsedUrl);
		}

		return serveError(req, res, 404, 'Not found.');
	} catch (error) {
		console.error(error.toString());

		return serveError(req, res, 500, 'Internal Server Error.');
	}
});

server.listen(LOCAL_PORT, () => {
	if (LOCAL_PORT !== PORT) {
		console.log(`Operating location at http://0.0.0.0:${LOCAL_PORT}`);
	}
	console.log(`Web UI available at   ${SCHEME}://${AUTHORITY}`);
});

server.on('error', err => {
	console.error(`Error occurred in server:`);
	console.error(err);
});

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {import('url').UrlWithParsedQuery} parsedUrl
 */
async function handleStatic(req, res, parsedUrl) {

	if (/^\/static\/extensions\//.test(parsedUrl.pathname)) {
		const relativePath = decodeURIComponent(parsedUrl.pathname.substr('/static/extensions/'.length));
		const filePath = getExtensionFilePath(relativePath, (await builtInExtensionsPromise).locations);
		if (!filePath) {
			return serveError(req, res, 400, `Bad request.`);
		}
		return serveFile(req, res, filePath, {
			'Access-Control-Allow-Origin': '*'
		});
	}

	// Strip `/static/` from the path
	const relativeFilePath = path.normalize(decodeURIComponent(parsedUrl.pathname.substr('/static/'.length)));

	return serveFile(req, res, path.join(APP_ROOT, relativeFilePath));
}

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {import('url').UrlWithParsedQuery} parsedUrl
 */
async function handleExtension(req, res, parsedUrl) {
	// Strip `/extension/` from the path
	const relativePath = decodeURIComponent(parsedUrl.pathname.substr('/extension/'.length));
	const filePath = getExtensionFilePath(relativePath, (await defaultExtensionsPromise).locations);
	if (!filePath) {
		return serveError(req, res, 400, `Bad request.`);
	}
	return serveFile(req, res, filePath, {
		'Access-Control-Allow-Origin': '*'
	});
}

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 */
async function handleRoot(req, res) {
	let folderUri = { scheme: 'memfs', path: `/sample-folder` };

	const match = req.url && req.url.match(/\?([^#]+)/);
	if (match) {
		const qs = new URLSearchParams(match[1]);

		let gh = qs.get('gh');
		if (gh) {
			if (gh.startsWith('/')) {
				gh = gh.substr(1);
			}

			const [owner, repo, ...branch] = gh.split('/', 3);
			const ref = branch.join('/');
			folderUri = { scheme: 'github', authority: `${owner}+${repo}${ref ? `+${ref}` : ''}`, path: '/' };
		} else {
			let cs = qs.get('cs');
			if (cs) {
				if (cs.startsWith('/')) {
					cs = cs.substr(1);
				}

				const [owner, repo, ...branch] = cs.split('/');
				const ref = branch.join('/');
				folderUri = { scheme: 'codespace', authority: `${owner}+${repo}${ref ? `+${ref}` : ''}`, path: '/' };
			}
		}
	}

	const { extensions: builtInExtensions } = await builtInExtensionsPromise;
	const { extensions: staticExtensions } = await defaultExtensionsPromise;

	if (args.verbose) {
		fancyLog(`${ansiColors.magenta('BuiltIn extensions')}: ${builtInExtensions.map(e => path.basename(e.extensionPath)).join(', ')}`);
		fancyLog(`${ansiColors.magenta('Additional extensions')}: ${staticExtensions.map(e => path.basename(e.extensionLocation.path)).join(', ') || 'None'}`);
	}

	const webConfigJSON = {
		folderUri: folderUri,
		staticExtensions,
	};
	if (args['wrap-iframe']) {
		webConfigJSON._wrapWebWorkerExtHostInIframe = true;
	}

	const data = (await readFile(WEB_MAIN)).toString()
		.replace('{{WORKBENCH_WEB_CONFIGURATION}}', () => escapeAttribute(JSON.stringify(webConfigJSON))) // use a replace function to avoid that regexp replace patterns ($&, $0, ...) are applied
		.replace('{{WORKBENCH_BUILTIN_EXTENSIONS}}', () => escapeAttribute(JSON.stringify(builtInExtensions)))
		.replace('{{WEBVIEW_ENDPOINT}}', '')
		.replace('{{REMOTE_USER_DATA_URI}}', '');

	res.writeHead(200, { 'Content-Type': 'text/html' });
	return res.end(data);
}

/**
 * Handle HTTP requests for /callback
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {import('url').UrlWithParsedQuery} parsedUrl
*/
async function handleCallback(req, res, parsedUrl) {
	const wellKnownKeys = ['vscode-requestId', 'vscode-scheme', 'vscode-authority', 'vscode-path', 'vscode-query', 'vscode-fragment'];
	const [requestId, vscodeScheme, vscodeAuthority, vscodePath, vscodeQuery, vscodeFragment] = wellKnownKeys.map(key => {
		const value = getFirstQueryValue(parsedUrl, key);
		if (value) {
			return decodeURIComponent(value);
		}

		return value;
	});

	if (!requestId) {
		res.writeHead(400, { 'Content-Type': 'text/plain' });
		return res.end(`Bad request.`);
	}

	// merge over additional query values that we got
	let query = vscodeQuery;
	let index = 0;
	getFirstQueryValues(parsedUrl, wellKnownKeys).forEach((value, key) => {
		if (!query) {
			query = '';
		}

		const prefix = (index++ === 0) ? '' : '&';
		query += `${prefix}${key}=${value}`;
	});


	// add to map of known callbacks
	mapCallbackUriToRequestId.set(requestId, JSON.stringify({ scheme: vscodeScheme || 'code-oss', authority: vscodeAuthority, path: vscodePath, query, fragment: vscodeFragment }));
	return serveFile(req, res, path.join(APP_ROOT, 'resources', 'serverless', 'callback.html'), { 'Content-Type': 'text/html' });
}

/**
 * Handle HTTP requests for /fetch-callback
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {import('url').UrlWithParsedQuery} parsedUrl
*/
async function handleFetchCallback(req, res, parsedUrl) {
	const requestId = getFirstQueryValue(parsedUrl, 'vscode-requestId');
	if (!requestId) {
		res.writeHead(400, { 'Content-Type': 'text/plain' });
		return res.end(`Bad request.`);
	}

	const knownCallbackUri = mapCallbackUriToRequestId.get(requestId);
	if (knownCallbackUri) {
		mapCallbackUriToRequestId.delete(requestId);
	}

	res.writeHead(200, { 'Content-Type': 'text/json' });
	return res.end(knownCallbackUri);
}

/**
 * @param {import('url').UrlWithParsedQuery} parsedUrl
 * @param {string} key
 * @returns {string | undefined}
*/
function getFirstQueryValue(parsedUrl, key) {
	const result = parsedUrl.query[key];
	return Array.isArray(result) ? result[0] : result;
}

/**
 * @param {import('url').UrlWithParsedQuery} parsedUrl
 * @param {string[] | undefined} ignoreKeys
 * @returns {Map<string, string>}
*/
function getFirstQueryValues(parsedUrl, ignoreKeys) {
	const queryValues = new Map();

	for (const key in parsedUrl.query) {
		if (ignoreKeys && ignoreKeys.indexOf(key) >= 0) {
			continue;
		}

		const value = getFirstQueryValue(parsedUrl, key);
		if (typeof value === 'string') {
			queryValues.set(key, value);
		}
	}

	return queryValues;
}

/**
 * @param {string} value
 */
function escapeAttribute(value) {
	return value.replace(/"/g, '&quot;');
}

/**
 * @param {string} relativePath
 * @param {Object.<string, string>} locations
 * @returns {string | undefined}
*/
function getExtensionFilePath(relativePath, locations) {
	const firstSlash = relativePath.indexOf('/');
	if (firstSlash === -1) {
		return undefined;
	}
	const extensionId = relativePath.substr(0, firstSlash);

	const extensionPath = locations[extensionId];
	if (!extensionPath) {
		return undefined;
	}
	return path.join(extensionPath, relativePath.substr(firstSlash + 1));
}

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {string} errorMessage
 */
function serveError(req, res, errorCode, errorMessage) {
	res.writeHead(errorCode, { 'Content-Type': 'text/plain' });
	res.end(errorMessage);
}

const textMimeType = {
	'.html': 'text/html',
	'.js': 'text/javascript',
	'.json': 'application/json',
	'.css': 'text/css',
	'.svg': 'image/svg+xml',
};

const mapExtToMediaMimes = {
	'.bmp': 'image/bmp',
	'.gif': 'image/gif',
	'.ico': 'image/x-icon',
	'.jpe': 'image/jpg',
	'.jpeg': 'image/jpg',
	'.jpg': 'image/jpg',
	'.png': 'image/png',
	'.tga': 'image/x-tga',
	'.tif': 'image/tiff',
	'.tiff': 'image/tiff',
	'.woff': 'application/font-woff'
};

/**
 * @param {string} forPath
 */
function getMediaMime(forPath) {
	const ext = path.extname(forPath);

	return mapExtToMediaMimes[ext.toLowerCase()];
}

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {string} filePath
 */
async function serveFile(req, res, filePath, responseHeaders = Object.create(null)) {
	try {

		// Sanity checks
		filePath = path.normalize(filePath); // ensure no "." and ".."

		const stat = await util.promisify(fs.stat)(filePath);

		// Check if file modified since
		const etag = `W/"${[stat.ino, stat.size, stat.mtime.getTime()].join('-')}"`; // weak validator (https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/ETag)
		if (req.headers['if-none-match'] === etag) {
			res.writeHead(304);
			return res.end();
		}

		// Headers
		responseHeaders['Content-Type'] = textMimeType[path.extname(filePath)] || getMediaMime(filePath) || 'text/plain';
		responseHeaders['Etag'] = etag;

		res.writeHead(200, responseHeaders);

		// Data
		fs.createReadStream(filePath).pipe(res);
	} catch (error) {
		console.error(error.toString());
		res.writeHead(404, { 'Content-Type': 'text/plain' });
		return res.end('Not found');
	}
}

if (args.launch !== false) {
	opn(`${SCHEME}://${HOST}:${PORT}`);
}
