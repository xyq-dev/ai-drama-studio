import type { MediaSubmitResult } from "./media-adapter";

// The synchronous terminal path must supply an artifact to Core.
const emptySuccess: MediaSubmitResult = {
  kind: "succeeded",
  providerRequestId: "provider-request",
  // @ts-expect-error Successful submissions cannot contain an empty output list.
  outputs: [],
};

void emptySuccess;
