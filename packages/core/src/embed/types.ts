export interface Embedder {
  readonly model: string;
  readonly dim: number;
  embed(texts: readonly string[]): Promise<Float32Array[]>;
}
