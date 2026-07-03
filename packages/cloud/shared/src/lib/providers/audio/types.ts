import type {
  AudioProductFamily,
  PricingBillingSource,
} from "../../services/ai-pricing-definitions";

/**
 * Persistence seam for providers that return raw audio bytes instead of a
 * hosted URL. The route constructs it (closing over the R2 binding and the
 * authenticated org/user), so providers never see storage credentials.
 */
export interface AudioStorage {
  put(params: {
    body: ArrayBuffer;
    contentType: string;
    extension: string;
  }): Promise<{ url: string; key: string }>;
}

export interface AudioGenerationRequest {
  model: string;
  prompt: string;
  productFamily: AudioProductFamily;
  lyrics?: string;
  lyricsOptimizer?: boolean;
  instrumental?: boolean;
  durationSeconds?: number;
  referenceUrl?: string;
  seed?: number;
  outputFormat?: string;
  audio?: {
    format?: string;
    sampleRate?: string;
    bitrate?: string;
  };
  extraInput?: Record<string, unknown>;
  apiKeys: Record<string, string | undefined>;
  storage?: AudioStorage;
}

export interface GeneratedAudioObject {
  url: string;
  file_name?: string;
  file_size?: number;
  content_type?: string;
}

export interface GeneratedAudio {
  requestId?: string;
  status?: string;
  audio: GeneratedAudioObject;
  raw?: unknown;
}

export interface AudioProvider {
  billingSource: PricingBillingSource;
  displayName: string;
  capabilities: readonly AudioProductFamily[];
  /** True when the provider returns raw bytes and needs request.storage to persist them. */
  requiresStorage?: boolean;
  isConfigured?(apiKeys: Record<string, string | undefined>): boolean;
  generate(req: AudioGenerationRequest): Promise<GeneratedAudio>;
  healthCheck?(): Promise<boolean>;
}
