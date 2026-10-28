// SPDX-License-Identifier: Apache-2.0
export interface Embedder {
  readonly model: string;
  readonly dim: number;
  embed(texts: readonly string[]): Promise<Float32Array[]>;
  // Embed a search query. Models trained with a query instruction (bge) add
  // it here; without this method a query is embedded like any text.
  embedQuery?(text: string): Promise<Float32Array>;
}
