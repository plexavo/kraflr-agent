import { mkdir, writeFile,readFile,unlink,lstat,chmod } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { launcher } from './commands.ts'

export async function install(root:string){
  const directory=process.platform==='win32'?join(process.env.LOCALAPPDATA??homedir(),'Kraflr','bin'):join(homedir(),'.local','bin')
  await mkdir(directory,{recursive:true,mode:0o700})
  const bundled=join(root,'.tools','node-v26.13.1-win-x64','node.exe'),node=process.platform==='win32'&&existsSync(bundled)?bundled:process.execPath
  for(const name of ['kraflr']){
    const target=join(directory,name+(process.platform==='win32'?'.cmd':''))
    try{if((await lstat(target)).isSymbolicLink())throw new Error('The command path is a link: '+target+'. Choose a regular per-user launcher path.')}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
    await writeFile(target,launcher(node,join(root,'bin','kraflr.mjs')),{mode:0o700})
    if(process.platform!=='win32')await chmod(target,0o700)
  }
  // Remove the retired typo only when its contents exactly match our own launcher.
  const retired=join(directory,'karflr'+(process.platform==='win32'?'.cmd':''))
  const retiredInfo=await lstat(retired).catch(()=>undefined)
  if(retiredInfo?.isFile()&&!retiredInfo.isSymbolicLink()&&await readFile(retired,'utf8')===launcher(node,join(root,'bin','kraflr.mjs')))await unlink(retired)
  if(process.platform==='win32'){
    // Pass the literal path as an argument; never interpolate it into shell source.
    const script=join(directory,'install-path.ps1')
    await writeFile(script,'param([string]$CommandPath)\n$currentPath = [Environment]::GetEnvironmentVariable("Path", "User")\n$parts = @($currentPath -split ";" | Where-Object { $_ })\nif ($parts -notcontains $CommandPath) { [Environment]::SetEnvironmentVariable("Path", (($parts + $CommandPath) -join ";"), "User") }\nAdd-Type -TypeDefinition \'using System; using System.Runtime.InteropServices; public static class KraflrEnvironmentNotice { [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessageTimeout(IntPtr w, uint m, IntPtr p, string s, uint f, uint t, out IntPtr r); }\'\n[System.IntPtr]$noticeResult=[System.IntPtr]::Zero\n[KraflrEnvironmentNotice]::SendMessageTimeout([System.IntPtr]0xffff,0x1a,[System.IntPtr]::Zero,"Environment",2,2000,[ref]$noticeResult) | Out-Null\n')
    await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-File',script,'-CommandPath',directory],{windowsHide:true,timeout:10_000})
    return 'Installed kraflr in '+directory+'. Open a new CMD or PowerShell window, then run kraflr.'
  }
  return 'Installed kraflr in '+directory+'. Ensure ~/.local/bin is on PATH, then run kraflr.'
}
