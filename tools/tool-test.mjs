/**
 * Agent 工具的 Node 单测：用恒等的 `defineTool` 替身直接驱动 `execute()`。
 *
 * 不需要 GUI、不需要模型、不需要 dsh 运行时 —— 工具的输入输出是纯逻辑。
 * 注意：必须从 profile 内的副本运行（`profiles/node_modules/dsh-asset-library/tools/`），
 * 因为 `lib/config.js` 要解析 `@deepseek-ai/schemastery`，而那只在 profile 树内可达。
 *
 * 用法：node tools/tool-test.mjs <fixture-project-root>
 */
import { mkdtemp, copyFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createService } from '../lib/service.js';
import { buildToolDefinitions, resolveScope } from '../lib/tools.js';
import { ASSET_LIBRARY_DEFAULTS, resolveConfig } from '../lib/config.js';

const fixture = process.argv[2];
if (fixture === undefined) {
    console.error('usage: node tools/tool-test.mjs <fixture-project-root>');
    process.exit(2);
}

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
    if (ok) {
        pass += 1;
        console.log(`  PASS  ${name}${detail ? `  (${detail})` : ''}`);
    } else {
        fail += 1;
        console.log(`  FAIL  ${name}${detail ? `  (${detail})` : ''}`);
    }
}

const home = await mkdtemp(join(tmpdir(), 'asset-lib-home-'));
const config = resolveConfig({ ...ASSET_LIBRARY_DEFAULTS, root: fixture, dshHome: home });
const service = createService({ config, logger: { info() {}, warn() {} } });
const definitions = buildToolDefinitions((definition) => definition, service, config);
const byName = new Map(definitions.map((definition) => [definition.name, definition]));
const execWithCwd = { agent: { session: { header: { cwd: fixture } } } };

console.log('== tool surface ==');
check('three tools defined', definitions.length === 3, definitions.map((d) => d.name).join(','));
check('names are stable', ['asset_library_list', 'asset_library_get', 'asset_library_overview'].every((n) => byName.has(n)));
check('every tool declares an output schema', definitions.every((d) => d.output?.schema !== undefined && typeof d.output.render === 'function'));
check('list declares required-free parameters', byName.get('asset_library_list').parameters.kind !== undefined);
check('get declares relPath as required', byName.get('asset_library_get').parameters.relPath.required === true);

console.log('== asset_library_list ==');
const listText = await byName.get('asset_library_list').execute({}, execWithCwd);
check('lists every asset (9)', listText.includes('匹配 9 项'), listText.split('\n')[1]);
check('reports the scanned folder', listText.includes(join(fixture, 'assets')), '');
check('includes a relative path', listText.includes('images/cover.png'));
check('type breakdown is present', listText.includes('图片 5 / 视频 2 / 音频 2'));
const imageText = await byName.get('asset_library_list').execute({ kind: 'image', limit: 3 }, execWithCwd);
check('kind filter narrows to images', imageText.includes('匹配 5 项') && imageText.includes('图片 5 / 视频 0 / 音频 0'));
check('limit is honoured', imageText.includes('返回第 1-3 项'));
check('hasMore hint appears', imageText.includes('还有更多'));
const searchText = await byName.get('asset_library_list').execute({ q: 'nested' }, execWithCwd);
check('q filter works', searchText.includes('匹配 1 项'));
const dirText = await byName.get('asset_library_list').execute({ dir: 'images' }, execWithCwd);
check('dir filter works', dirText.includes('匹配 4 项'));
const emptyText = await byName.get('asset_library_list').execute({ q: 'zzz-not-there' }, execWithCwd);
check('empty result explains itself', emptyText.includes('没有匹配的资产') && emptyText.includes('现有 9 个资产'));

console.log('== annotation round trip through the tools ==');
await service.annotate('images/cover.png', { tags: ['单元测试', 'ep1'], note: '来自单测' });
const taggedText = await byName.get('asset_library_list').execute({ tag: '单元测试' }, execWithCwd);
check('tag filter sees the annotation', taggedText.includes('匹配 1 项'));
const noteSearchText = await byName.get('asset_library_list').execute({ q: '来自单测' }, execWithCwd);
check('q matches notes as well as paths', noteSearchText.includes('匹配 1 项'));
const orderAscText = await byName.get('asset_library_list').execute({ sort: 'size', order: 'asc', limit: 1 }, execWithCwd);
check('order=asc flips size sorting', orderAscText.includes('logo.svg'), orderAscText.split('\n')[4] ?? '');
const detailText = await byName.get('asset_library_get').execute({ relPath: 'images/cover.png' }, execWithCwd);
check('detail shows both tags', detailText.includes('单元测试') && detailText.includes('ep1'));
check('detail shows the note', detailText.includes('来自单测'));
check('detail shows an absolute path', detailText.includes(join(fixture, 'assets', 'images', 'cover.png')));
const missingText = await byName.get('asset_library_get').execute({ relPath: 'images/nope.png' }, execWithCwd);
check('unknown asset explains itself', missingText.includes('没有找到资产'));

console.log('== asset_library_overview ==');
const overviewText = await byName.get('asset_library_overview').execute({}, execWithCwd);
check('overview counts 9', overviewText.includes('合计：9 项'));
check('overview lists subfolders', overviewText.includes('images') && overviewText.includes('audio'));
check('overview marks the root folder', overviewText.includes('(根目录)'));

console.log('== scope resolution ==');
check('explicit root wins over cwd', resolveScope({ root: 'G:\\somewhere' }, execWithCwd) === 'G:\\somewhere');
check('cwd is the fallback', resolveScope({}, execWithCwd) === fixture);
check('no scope when neither is set', resolveScope({}, {}) === undefined);
const other = await mkdtemp(join(tmpdir(), 'asset-lib-other-'));
await mkdir(join(other, 'assets', 'images'), { recursive: true });
await copyFile(join(fixture, 'assets', 'images', 'cover.png'), join(other, 'assets', 'images', 'only.png'));
await writeFile(join(other, 'assets', 'images', 'skip.txt'), 'not an asset');
const scopedText = await byName.get('asset_library_list').execute({ root: other }, execWithCwd);
check('root parameter switches project', scopedText.includes('匹配 1 项') && scopedText.includes('only.png'), scopedText.split('\n')[1]);
check('cached scan per root does not leak', scopedText.includes(join(other, 'assets')));
const backText = await byName.get('asset_library_list').execute({}, execWithCwd);
check('previous project still resolves after scope switch', backText.includes('匹配 9 项'));

console.log('== dimensions from header probing ==');
const dimsText = await byName.get('asset_library_get').execute({ relPath: 'images/cover.png' }, execWithCwd);
check('get reports probed dimensions', dimsText.includes('尺寸：640 × 360'), dimsText.split('\n')[3] ?? '');
const listLine = await byName.get('asset_library_get').execute({ relPath: 'images/logo.svg' }, execWithCwd);
check('unprobed formats omit the size line', !listLine.includes('尺寸：'));

console.log('== agent annotate tool is gated by config ==');
const defaultDefinitions = buildToolDefinitions((definition) => definition, service, config);
check('annotate tool absent by default', !defaultDefinitions.some((definition) => definition.name === 'asset_library_annotate'));
const openConfig = resolveConfig({ ...ASSET_LIBRARY_DEFAULTS, root: fixture, dshHome: home, allowAgentAnnotate: true });
const openDefinitions = buildToolDefinitions((definition) => definition, createService({ config: openConfig, logger: { info() {}, warn() {} } }), openConfig);
const annotateTool = openDefinitions.find((definition) => definition.name === 'asset_library_annotate');
check('annotate tool appears when allowAgentAnnotate is on', annotateTool !== undefined);
if (annotateTool !== undefined) {
    const annotatedText = await annotateTool.execute({ relPath: 'images/portrait.png', tags: '智能生成, 备选', note: '来自 Agent 的备注' }, execWithCwd);
    check('annotate tool writes tags and note', annotatedText.includes('已写入标注') && annotatedText.includes('智能生成') && annotatedText.includes('来自 Agent 的备注'), annotatedText.split('\n')[0] ?? '');
    const noopText = await annotateTool.execute({ relPath: 'images/portrait.png' }, execWithCwd);
    check('annotate tool without payload is a no-op', noopText.includes('什么都没有改'));
    const missingText = await annotateTool.execute({ relPath: 'images/nope.png', tags: 'x' }, execWithCwd);
    check('annotate tool explains a missing asset', missingText.includes('没有找到资产'));
}

console.log('');
console.log(`RESULT: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
