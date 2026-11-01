export function workerComposePolicy(input:{production:boolean;localEnabled:boolean;episodeEnabled:boolean;mockDirectoryReady:boolean;
  workDirectoryReady:boolean;objectDirectoryReady:boolean;realAccessAllowed:boolean;receiptReady:boolean;s3Ready:boolean}){
  const paths=input.workDirectoryReady&&input.objectDirectoryReady;
  const mockCompose=!input.production&&input.localEnabled&&input.mockDirectoryReady&&paths;
  const realCompose=input.localEnabled&&input.realAccessAllowed&&input.receiptReady&&input.s3Ready&&paths;
  return {mockCompose,realCompose,localCompose:mockCompose||realCompose,episodeCompose:input.episodeEnabled&&(mockCompose||realCompose)};
}
