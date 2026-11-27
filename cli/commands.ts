/** Quote literal executable paths for a POSIX launcher, including spaces and shell metacharacters. */
export const shellQuote = (text:string) => "'" + text.replaceAll("'", "'\\''") + "'"
export const launcher = (node:string,entry:string,windows=process.platform==='win32') => windows
  ? `@echo off\r\n"${node.replaceAll('%','%%')}" "${entry.replaceAll('%','%%')}" %*\r\n`
  : `#!/bin/sh\nexec ${shellQuote(node)} ${shellQuote(entry)} "$@"\n`
