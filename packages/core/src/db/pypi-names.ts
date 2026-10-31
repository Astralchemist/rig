// SPDX-License-Identifier: Apache-2.0

// A PyPI distribution's name is not always the module it installs:
// `PyYAML` is imported as `yaml`. Declared distributions and imports are
// compared on PEP 503-normalized names, plus a short table of renames.

// PEP 503: lowercase, with each run of '-', '_' and '.' collapsed to '-'.
// 'Flask' → 'flask', 'typing_extensions' → 'typing-extensions'.
export const normalizePypiName = (name: string): string =>
  name.toLowerCase().replace(/[-_.]+/g, '-');

// Import names of common distributions whose normalized name differs from
// what they install, keyed by that normalized name. Values are written as
// Python spells the module. Anything not listed matches by its own name.
export const DIST_IMPORT_NAMES: Readonly<Record<string, readonly string[]>> = {
  attrs: ['attr'],
  beautifulsoup4: ['bs4'],
  djangorestframework: ['rest_framework'],
  'opencv-python': ['cv2'],
  'opencv-python-headless': ['cv2'],
  pillow: ['PIL'],
  protobuf: ['google.protobuf'],
  'psycopg2-binary': ['psycopg2'],
  pyjwt: ['jwt'],
  'python-dateutil': ['dateutil'],
  'python-dotenv': ['dotenv'],
  // The most-used modules of pywin32, which installs many top-level ones.
  pywin32: ['win32api', 'win32con', 'win32gui', 'win32com', 'win32file', 'pythoncom', 'pywintypes'],
  pyyaml: ['yaml'],
  'scikit-image': ['skimage'],
  'scikit-learn': ['sklearn'],
};

// The keys an absolute import matches a distribution by: each dotted prefix
// of the module, normalized. 'google.protobuf.json_format' → google,
// google-protobuf, google-protobuf-json-format. Relative imports have none.
export const importKeysOf = (target: string): string[] => {
  if (target.startsWith('.')) return [];
  const parts = target.split('.');
  return parts.map((_, i) => normalizePypiName(parts.slice(0, i + 1).join('.')));
};

// The keys a declared distribution answers to: its own normalized name, plus
// its import names from DIST_IMPORT_NAMES.
// Split distributions install their module under the family name:
// opentelemetry-api and opentelemetry-sdk both install `opentelemetry`.
const FAMILY_SUFFIX = /^(.+)-(api|sdk|binary|headless)$/;

export const distributionKeysOf = (name: string): string[] => {
  const key = normalizePypiName(name);
  const family = FAMILY_SUFFIX.exec(key)?.[1];
  return [
    key,
    ...(DIST_IMPORT_NAMES[key] ?? []).map(normalizePypiName),
    ...(family ? [family] : []),
  ];
};
