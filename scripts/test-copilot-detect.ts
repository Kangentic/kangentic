import { CopilotDetector } from '../src/main/agent/adapters/copilot/detector';
import path from 'node:path';

const detector = new CopilotDetector();
const overridePath = path.join(
  process.env.LOCALAPPDATA || '',
  'Microsoft/WinGet/Packages/GitHub.Copilot_Microsoft.Winget.Source_8wekyb3d8bbwe/copilot.exe',
);
console.log('Testing with override path:', overridePath);
detector.detect(overridePath).then((result) => {
  console.log(JSON.stringify(result, null, 2));
  if (!result.found) {
    console.log('\nAlso trying without override (PATH lookup):');
    detector.detect().then((result2) => {
      console.log(JSON.stringify(result2, null, 2));
    });
  }
});
