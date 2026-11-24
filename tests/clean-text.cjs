// cleanText (scripts/clean-text.ts) on literal escapes and paths: npm run test:clean-text.
const assert = require('node:assert/strict');

// [input, expected]; backslashes are the literal characters the docs leave in the text.
const cases = [
  ['list:\\r- item\\nNext', 'list: - item Next'],
  ['x\\nC:\\reports', 'x C:\\reports'],
  ['Saved to C:\\temp.\\r\\nNext line', 'Saved to C:\\temp. Next line'],
  ['Copy to C:\\reports\\new\\r\\nDone', 'Copy to C:\\reports\\new Done'],
  ['Share \\\\server\\new\\n\\nnext', 'Share \\\\server\\new next'],
  ['x\\n\\\\server\\reports', 'x \\\\server\\reports'],
  ['Note:\\nfoo', 'Note: foo'],
  ['The returned object can be a:\\r- x\\r- y', 'The returned object can be a: - x - y'],
  ['Use the format domain\\name, where name is', 'Use the format domain\\name, where name is'],
  ['in case of failure\\nThis action will retry', 'in case of failure This action will retry'],
  ['the parent\\rconversation', 'the parent conversation'],
  ['Admin share C$ at \\\\host\\C$\\r\\n', 'Admin share C$ at \\\\host\\C$'],
  ['a <!-- 10519922 --> b', 'a b'],
  ['{{ Fill in the Synopsis }}', ''],
  ['## SYNTAX', ''],
];
(async () => {
  const { cleanText } = await import('../scripts/clean-text.ts');
  let failed = 0;
  for (const [input, expected] of cases) {
    try {
      assert.equal(cleanText(input), expected, input);
    } catch (e) {
      failed++;
      console.error(e.message);
    }
  }
  if (failed) process.exit(1);
  console.log(`clean-text: ${cases.length} cases pass`);
})();
