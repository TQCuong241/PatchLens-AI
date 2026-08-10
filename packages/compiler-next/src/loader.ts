import { instrumentNextSource } from './instrument.js';

type LoaderOptions = {
  enabled?: boolean;
  root?: string;
};

type LoaderContext = {
  mode?: string;
  resourcePath: string;
  rootContext?: string;
  getOptions?: () => LoaderOptions;
  cacheable?: (cacheable?: boolean) => void;
};

export default function patchLensNextLoader(this: LoaderContext, source: string): string {
  this.cacheable?.(true);
  const options = this.getOptions?.() ?? {};
  const enabled =
    options.enabled !== false &&
    this.mode !== 'production' &&
    process.env.NODE_ENV !== 'production';
  if (!enabled) {
    return source;
  }

  return instrumentNextSource({
    code: source,
    id: this.resourcePath,
    root: options.root ?? this.rootContext ?? process.cwd(),
  }).code;
}
