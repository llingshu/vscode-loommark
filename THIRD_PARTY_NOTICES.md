# Third-Party Notices

LoomMark includes or builds on the following open-source projects:

- [Milkdown](https://github.com/Milkdown/milkdown), including Crepe and Kit, licensed under the MIT
  License.
- [ProseMirror](https://github.com/ProseMirror), licensed under the MIT License.
- [CodeMirror](https://github.com/codemirror), licensed under the MIT License.
- [esbuild](https://github.com/evanw/esbuild), used to create release bundles and licensed under the
  MIT License.
- [Visual Studio Code Extension API typings](https://github.com/DefinitelyTyped/DefinitelyTyped),
  used for development under the MIT License.

Transitive dependency names, versions, source locations, and declared licenses are recorded in
`package-lock.json`. The release build derives [THIRD_PARTY_LICENSES.txt](THIRD_PARTY_LICENSES.txt)
from esbuild's bundle metadata so that the VSIX includes the declared license and available license
text for every package actually incorporated into the extension bundles.

Their copyright notices and license terms remain the property of their respective authors. This
notice is informational and does not replace those license texts.
