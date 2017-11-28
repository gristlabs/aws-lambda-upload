import 'dep1';
import * as bar from 'lib/bar';
import 'lib/baz_ts';
// This line helps verify that the file is parsed with TypeScript (not valid JS),
// AND that these imports aren't ignored (as TS has "elision of unused references").
const x: any = bar;
console.log("imported foo_ts.ts", Boolean(x));
