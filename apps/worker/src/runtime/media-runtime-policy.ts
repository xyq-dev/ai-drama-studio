export function workerComposePolicy(input:{production:boolean;localEnabled:boolean;episodeEnabled:boolean;mockDirectoryReady:boolean;
  workDirectoryReady:boolean;objectDirectoryReady:boolean;realAccessAllowed:boolean;receiptReady:boolean;s3Ready:boolean}){
  const paths=input.workDirectoryReady&&input.objectDirectoryReady;
  const mockCompose=!input.production&&input.localEnabled&&input.mockDirectoryReady&&paths;
  const realStorage=input.realAccessAllowed&&input.receiptReady&&input.s3Ready&&paths;
  const realCompose=input.localEnabled&&realStorage;
  // Episodes read already-produced local composites; they need neither a Mock source directory nor the shot switch.
  const episodeCompose=input.episodeEnabled&&paths&&(!input.production||realStorage);
  return {mockCompose,realCompose,localCompose:mockCompose||realCompose,episodeCompose};
}
