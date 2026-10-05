declare module '@deepseek-ai/dsh-client-connection' {
  export const clientRequestSchema:{safeParse(value:unknown):{success:true;data:{type:'client-request';rpcId:string;method:string;payload:unknown}}|{success:false}};
}
