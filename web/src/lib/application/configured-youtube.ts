import "server-only";

import { createGoogleOAuthAdapter } from "@/lib/adapters/google/oauth";
import { createYouTubeAnalyticsAdapter } from "@/lib/adapters/google/youtube-analytics";
import { createYouTubeDataAdapter } from "@/lib/adapters/google/youtube-data";
import type { ServerEnv } from "@/lib/config/env";
import { YOUTUBE_SCOPES } from "@/lib/domain/youtube";
import { createCredentialCipher, YOUTUBE_CIPHER_PROFILE } from "@/lib/security/credential-cipher";

/**
 * Wires env into the YouTube ports, mirroring createConfiguredDrive.
 *
 * The OAuth adapter is built with the YouTube scope pair, so a grant that comes
 * back narrower or wider is rejected by the adapter itself; the cipher is bound
 * to YOUTUBE_CIPHER_PROFILE and the separate YOUTUBE_TOKEN_KEY_V1, so a Drive
 * envelope can never be decrypted here and vice versa.
 */
export function createConfiguredYouTube(env: ServerEnv) {
  return Object.freeze({
    oauth: createGoogleOAuthAdapter({
      clientId: env.googleOAuthClientId,
      clientSecret: env.googleOAuthClientSecret,
      scopes: YOUTUBE_SCOPES,
    }),
    cipher: createCredentialCipher(env.youtubeTokenKeyV1, YOUTUBE_CIPHER_PROFILE),
    data: createYouTubeDataAdapter(),
    analytics: createYouTubeAnalyticsAdapter(),
  });
}
