import { useAuthStore } from '../stores/auth.store';
export async function analyzeStream(previewId:string, signal:AbortSignal, onText:(text:string)=>void):Promise<any> {
 const response=await fetch('/api/v1/ai/analyze',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json',Accept:'text/event-stream'},body:JSON.stringify({previewId,confirm:true}),signal});
 if(response.status===401) {await useAuthStore().logout();throw new Error('Session expired.');}
 if(!response.ok) throw new Error('AI request failed: HTTP '+response.status);
 if(!response.headers.get('content-type')?.includes('text/event-stream'))return response.json();
 const reader=response.body!.getReader();const decoder=new TextDecoder();let buffer='';let result:any;let size=0;
 try {while(true){const item=await reader.read();if(item.done)break;size+=item.value.byteLength;if(size>2000000)throw new Error('AI response too large.');buffer+=decoder.decode(item.value,{stream:true});let n:number;while((n=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,n).trim();buffer=buffer.slice(n+1);if(!line.startsWith('data:'))continue;const event=JSON.parse(line.slice(5));if(event.type==='analysis')onText(String(event.data));if(event.type==='result')result=event.data;if(event.type==='error')throw new Error(String(event.data));}}
 if(!result)throw new Error('AI stream interrupted.');return result;
 }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
