/** Recognize a user's short approval phrase only to OPEN plan review, never to grant execution. */
export class ApprovalInput{
 private typed='';private eligible=true;private paste=''
 input(text:string):boolean{
  if(/^\x1b\[<(?:\d+);\d+;\d+[Mm]$/.test(text)||/^\x1b\[[?>\d;]*[cRn]$/.test(text))return false
  if(this.paste){text=this.paste+text;this.paste=''}
  if(text.startsWith('\x1b[200~')){const end=text.indexOf('\x1b[201~',6);if(end<0){if(text.length<128_000)this.paste=text;else this.eligible=false;return false}const body=text.slice(6,end);if(/[\r\n\x00-\x1f]/.test(body))this.eligible=false;this.typed=(this.typed+body).slice(0,128);if(this.typed.length>64)this.eligible=false;return text.length>end+6?this.input(text.slice(end+6)):false}
  let matched=false
  for(const character of text){
   if(character==='\r'||character==='\n'){matched ||= this.eligible&&/^(?:i\s+approve|approve(?:\s+the\s+test)?|(?:please\s+)?(?:run|execute|start)\s+(?:the\s+)?(?:docker|lab|test|verification)\b[^?]{0,40}?)[.!]?$/i.test(this.typed.trim());this.typed='';this.eligible=true}
   else if(character==='\x03'||character==='\x15'){this.typed='';this.eligible=true}
   else if(character==='\x7f'||character==='\b')this.typed=Array.from(this.typed).slice(0,-1).join('')
   else if(character<' ')this.eligible=false
   else{this.typed=(this.typed+character).slice(0,128);if(this.typed.length>64)this.eligible=false}
  }
  return matched
 }
}
