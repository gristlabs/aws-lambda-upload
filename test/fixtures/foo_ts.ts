import 'dep1';
import * as bar from 'lib/bar';
import 'lib/baz_ts';
import * as dep3 from 'dep3';
// This line helps verify that the file is parsed with TypeScript (not valid JS),
// AND that these imports aren't ignored (as TS has "elision of unused references").
const x: any[] = [bar, dep3];
console.log("imported foo_ts.ts" as string);
