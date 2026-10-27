/** Paths that make poor Drills even in a recognised language: tests, and generated or vendored code. */
const TEST_PATH = /(^|\/)(tests?|__tests__|specs?|testdata|fixtures)\/|[._-](test|spec)\.[^/]+$|(^|\/)test_[^/]+\.py$|_test\.go$/i;
const GENERATED_PATH = /(^|\/)(vendor|node_modules|dist|build|out|third_party|generated|\.kintsugi)\/|\.min\.[^/]+$|\.pb\.go$|_generated\.|\.generated\.|\.d\.ts$/i;

/** True for a repository-relative path that could hold code worth drilling. */
export const isDrillableSourcePath = (path: string) => !TEST_PATH.test(path) && !GENERATED_PATH.test(path);
