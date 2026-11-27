import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile,unlink,access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import test from 'node:test'
import { setTimeout as wait } from 'node:timers/promises'
import { buildApp } from '../server/app.ts'
import { openStore } from '../server/db.ts'
import type { SourceReviewEngine } from '../server/source-review-engine.ts'
import { emptyScope } from '../shared/research.ts'
import type { SourcePreview, SourceReviewRun } from '../shared/source-review.ts'
import {readPinnedSource} from '../server/pinned-source.ts'
import {shellQuote} from '../cli/commands.ts'

test('missing promisor objects cannot execute a remote transport during a bounded source read',async t=>{
  const base=await realpath(tmpdir()),dir=await mkdtemp(join(base,'kraflr-promisor-')),repo=join(dir,'clone'),marker=join(dir,'transport-ran')
  t.after(async()=>{const target=await realpath(dir);if(/^kraflr-promisor-[^\\/]+$/.test(relative(base,target)))await rm(target,{recursive:true,force:true})})
  await mkdir(repo);await writeFile(join(repo,'source.txt'),'synthetic source\n')
  const git=(...args:string[])=>execFileSync('git',['-C',repo,...args],{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null'}}).trim()
  git('init','--initial-branch=main','--template=');git('add','source.txt');git('-c','user.name=QA','-c','user.email=qa@example.test','-c','commit.gpgsign=false','commit','-m','Synthetic object')
  const commit=git('rev-parse','HEAD'),blob=git('rev-parse','HEAD:source.txt');assert.match(blob,/^[a-f0-9]{40,64}$/)
  const helper=join(dir,'transport.mjs');await writeFile(helper,`import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(marker)},'should never run')`)
  git('config','remote.origin.url','ssh://example.invalid/never-contact');git('config','remote.origin.promisor','true');git('config','extensions.partialClone','origin')
  git('config','core.sshCommand',shellQuote(process.execPath.replaceAll('\\','/'))+' '+shellQuote(helper.replaceAll('\\','/')))
  await unlink(join(repo,'.git','objects',blob.slice(0,2),blob.slice(2)))
  await assert.rejects(readPinnedSource({...emptyScope,repository:repo,revision:commit,version:1,savedAt:new Date().toISOString()},{scopeVersion:1,path:'source.txt',startLine:1,endLine:1,model:'',objective:''}),/Git could not read the file/)
  await assert.rejects(access(marker),/ENOENT/)
})

test('scoped reviews send only the approved Git lines and persist validated evidence', async () => {
  const temp = await realpath(tmpdir())
  const dir = await mkdtemp(join(temp, 'kraflr-source-test-'))
  const repo = join(dir, 'local clone')
  const file = join(dir, 'research.sqlite')
  const git = (...args: string[]) => execFileSync('git', [
    '-C', repo, '-c', 'user.email=review@example.test', '-c', 'user.name=Review fixture',
    '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=disabled-hooks', ...args,
  ], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' } }).trim()
  let app: ReturnType<typeof buildApp> | undefined
  try {
    await mkdir(join(repo, 'src'), { recursive: true })
    await writeFile(join(repo, 'src', 'export.js'), 'outside-review\nconst entry = store.get(id);\nreturn entry.data;\n')
    git('init', '--initial-branch=main', '--template=')
    git('add', '--', 'src/export.js')
    git('update-index', '--add', '--cacheinfo', `120000,${git('rev-parse', ':src/export.js')},link.js`)
    git('commit', '-m', 'Synthetic source fixture')
    const commit = git('rev-parse', 'HEAD')
    await writeFile(join(repo, 'src', 'export.js'), 'uncommitted text\n')
    const store = openStore(file)
    const panel = store.createPanel({ name: 'Authorized fixture', type: 'source' })
    const other = store.createPanel({ name: 'Another panel', type: 'source' })
    const scope = { ...emptyScope, targetName: 'Export fixture', repository: repo, revision: commit, notes: 'local-only notes' }
    store.saveScope(panel.id, 0, scope)

    let calls = 0
    let release: (response: string) => void = () => {}
    const engine: SourceReviewEngine = {
      available: () => true,
      async generate(prompt, model, signal, beforeSend) {
        beforeSend()
        calls++
        assert.equal(model, 'fixture/model')
        assert.match(prompt, /security object with hypothesis/)
        assert.ok(prompt.includes('const entry = store.get(id);'))
        assert.ok(prompt.includes(commit))
        for (const excluded of [repo, 'local-only notes', 'outside-review', 'uncommitted text']) {
          assert.ok(!prompt.includes(excluded))
        }
        return new Promise<string>((resolve, reject) => {
          release = resolve
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      },
    }
    const host = '127.0.0.1:4317'
    const headers = { host, origin: `http://${host}`, 'content-type': 'application/json' }
    app = buildApp(store, 4317, { sourceReviewEngine: engine })
    const route = `/api/panels/${panel.id}/source-reviews`
    const post = (url: string, payload: object) => app!.inject({ url, method: 'POST', headers, payload })
    const select = { scopeVersion: 1, path: 'src/export.js', startLine: 2, endLine: 3,
      objective: 'Check that access is scoped.', model: 'fixture/model' }
    const list = async () => (await app!.inject({ url: route, headers })).json<{ runs: SourceReviewRun[] }>().runs
    const settled = async () => {
      for (let attempt = 0; attempt < 40; attempt++) {
        const run = (await list())[0]!
        if (run.status !== 'running') return run
        await wait(10)
      }
      throw new Error('Expected source review to finish')
    }

    assert.equal((await post(`${route}/preview`, { ...select, path: '../export.js' })).statusCode, 400)
    assert.equal((await post(`${route}/preview`, { ...select, path: 'link.js' })).statusCode, 422)
    const checked = await post(`${route}/preview`, select)
    assert.equal(checked.statusCode, 200, checked.body)
    const old = checked.json<SourcePreview>()
    assert.deepEqual(old.excerpt.lines, ['const entry = store.get(id);', 'return entry.data;'])
    assert.equal(calls, 0)
    store.saveScope(panel.id, 1, { ...scope, restrictions: 'Only review the selected excerpt.' })
    assert.equal((await post(route, { id: old.id })).statusCode, 409)

    const prepare = async () => {
      const response = await post(`${route}/preview`, { ...select, scopeVersion: 2 })
      assert.equal(response.statusCode, 200, response.body)
      return response.json<SourcePreview>()
    }
    const ready = await prepare()
    assert.equal((await post(`/api/panels/${other.id}/source-reviews`, { id: ready.id })).statusCode, 409)
    assert.equal((await post(route, { id: ready.id })).statusCode, 202)
    assert.equal((await post(route, { id: ready.id })).statusCode, 202)
    assert.equal(calls, 1)
    const lead = { title: 'Check access to the export', explanation: 'The excerpt returns the entry data.', startLine: 3, endLine: 3,
      kind: 'lead', security: {
        hypothesis: 'The selected export code may lack an ownership check.',
        attackPath: 'If a caller can supply an export ID, this read may reach another account’s record.',
        impact: 'Private export data could be disclosed across account boundaries.',
      } }
    release(JSON.stringify({ summary: 'Check the authorization context.', lead }))
    assert.deepEqual((await settled()).result?.lead, lead)

    const contextOnly = await prepare()
    assert.equal((await post(route, { id: contextOnly.id })).statusCode, 202)
    release(JSON.stringify({ summary: 'Background source context.', lead: { ...lead, kind: 'lead', security: undefined } }))
    assert.equal((await settled()).result?.lead?.kind, 'general')
    assert.equal(store.listEvidence(panel.id, 0, 'general').leads.length, 0)
    assert.equal(store.listEvidence(panel.id, 0, 'lead').leads.length, 1)
    assert.equal(store.readEvidence(panel.id, `${contextOnly.id}:source`).tag, 'lead')

    const badCitation = await prepare()
    assert.equal((await post(route, { id: badCitation.id })).statusCode, 202)
    release(JSON.stringify({ summary: 'Unsupported citation.', lead: { ...lead, startLine: 1 } }))
    assert.equal((await settled()).status, 'failed')
    assert.equal((await list())[0]?.result, null)

    const toCancel = await prepare()
    assert.equal((await post(route, { id: toCancel.id })).statusCode, 202)
    assert.equal((await post(`${route}/cancel`, { id: toCancel.id })).statusCode, 204)
    assert.equal((await settled()).status, 'cancelled')
    await app.close()
    app = undefined

    const reopened = openStore(file)
    try {
      const result = reopened.findSourceReview(panel.id, ready.id)
      assert.equal(result?.scopeVersion, 2)
      assert.equal(result?.excerpt.commit, commit)
      assert.deepEqual(result?.result?.lead, lead)
      const evidence = reopened.readEvidence(panel.id, `${ready.id}:source`)
      assert.equal(evidence.origin, 'source')
      assert.deepEqual(evidence.evidence, ['return entry.data;'])
      assert.deepEqual(reopened.listEvidence(panel.id, 0, 'lead').leads.map((item) => item.id), [evidence.id])
      assert.equal(reopened.readEvidence(panel.id, `${contextOnly.id}:source`).tag, 'lead')
      assert.equal(reopened.findSourceReview(other.id, ready.id), undefined)
    } finally {
      reopened.close()
    }
  } finally {
    await app?.close()
    if (/^kraflr-source-test-[^\\/]+$/.test(relative(temp, await realpath(dir)))) {
      await rm(dir, { recursive: true, force: true })
    }
  }
})
