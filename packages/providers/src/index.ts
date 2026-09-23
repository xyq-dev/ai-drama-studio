/**
 * M1-A placeholder. Adapter execution is not implemented.
 * Do not add vendor SDK dependencies or provider-specific payload fields in this milestone.
 */
export const M1A_PROVIDER_BOUNDARY = {
  stage: "m1a",
  adaptersImplemented: false,
} as const;

export type ProviderBoundary = typeof M1A_PROVIDER_BOUNDARY;
