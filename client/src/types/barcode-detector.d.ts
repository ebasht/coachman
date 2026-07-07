export {};

declare global {
  class BarcodeDetector {
    constructor(options?: { formats: string[] });
    static getSupportedFormats(): Promise<string[]>;
    detect(image: ImageBitmapSource): Promise<Array<{ rawValue: string }>>;
  }

  interface Window {
    BarcodeDetector?: typeof BarcodeDetector;
  }
}
