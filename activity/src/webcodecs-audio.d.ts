// Audio WebCodecs declarations for the APIs used here; no product dependency is required.
interface AudioDecoderConfig { codec: string; sampleRate: number; numberOfChannels: number; description?: BufferSource; }
interface AudioData {
 readonly timestamp: number; readonly numberOfFrames: number; readonly numberOfChannels: number; readonly sampleRate: number;
 copyTo(destination: Float32Array, options: { planeIndex: number; format: 'f32-planar' }): void;
 close(): void;
}
declare class EncodedAudioChunk {
 constructor(init: { type: 'key' | 'delta'; timestamp: number; duration?: number; data: BufferSource });
}
declare class AudioDecoder {
 constructor(init: { output: (data: AudioData) => void; error: (error: DOMException) => void });
 static isConfigSupported(config: AudioDecoderConfig): Promise<{ supported?: boolean; config: AudioDecoderConfig }>;
 readonly decodeQueueSize: number; readonly state: 'unconfigured' | 'configured' | 'closed';
 configure(config: AudioDecoderConfig): void; decode(chunk: EncodedAudioChunk): void; reset(): void; close(): void;
}
