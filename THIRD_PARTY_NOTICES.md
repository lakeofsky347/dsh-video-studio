# Third-party notices

This project's current code and documentation are licensed under Apache-2.0;
see LICENSE and NOTICE. The original MIT notice from earlier DSH Video Studio
releases is retained in `licenses/Legacy-MIT.txt` (distributed in
`lib/licenses/Legacy-MIT.txt`). Third-party components retain the licenses
listed below.

- Graph editor: `@comfyorg/litegraph` 0.17.2, Comfy-Org, MIT. The client bundles its independent graph kernel; its complete license is in `lib/licenses/LiteGraph-MIT.txt`. Source: https://github.com/Comfy-Org/litegraph.js/tree/v0.17.2
- ZIP style import: `fflate` 0.8.3, Arjun Barrett, MIT. Its browser implementation is bundled in the client factory; its complete license is in `lib/licenses/fflate-MIT.txt`. Source: https://github.com/101arrowz/fflate
- Browser driver: `playwright-core` 1.63.0, Microsoft contributors, Apache-2.0. Production dependency; license and notices are distributed with the package.
- DSH host services and shared React are supplied by the installed DSH runtime. This plugin does not redistribute the complete ComfyUI application or its Python inference backend.
- Frame contract and capture/encoding approach are adapted from the local frontend-video-foundation workpack 0.1.0. The plugin has its own runtime for image assets, DOM/Canvas scenes and embedded preview.
- Chrome/Chromium, FFmpeg and system fonts are used from the user's configured local environment; binaries and fonts are not included in this package.
