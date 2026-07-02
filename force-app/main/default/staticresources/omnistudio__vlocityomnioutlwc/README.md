# vlocityomnioutlwc

The LWC OmniOut static resource includes all necessary resources required for OmniScript to run outside of Salesforce.

## How to start?

1. Update the authentication key field located in the `.npmrc` with the NPM repository access key from your Vlocity customer representative.
2. Run `npm install`. This will install all dependencies.
3. Run `npm run watch`. This will start the project with a local development server on your local address `http://localhost:4002`. 

## Run your own off platform OmniScript.

1. Open an OmniScript in your Salesforce org, and click Activate.
2. Click on the Download Off Platform LWC button and uncompress the downloaded file.
3. Copy the component located in the vlocityomniscript folder of your downloaded component into the ./src/modules/vlocityomniscript folder of your OmniOut LWC project.
4. Update the import at the top of `./src/index.js` to match the added OmniScript's name.
   Example:
   ``` JS
   import VlocApp from 'vlocityomniscript/theNameOfDownloadedFolder';
   ```
5. Update the tag definition in `./src/index.js`.
   ``` JS
   customElements.define('vlocityomniscript-the-name-of-downloaded-folder', VlocApp.CustomElementConstructor);
   ```
6. Update the tag name found in `./src/index.html` with the newly defined tag.
   ``` HTML
   <vlocityomniscript-the-name-of-downloaded-folder run-mode="localScriptDef">
   </vlocityomniscript-the-name-of-downloaded-folder>
   ```
7. Run `npm run watch`. This will start the project with a local development server on your local address http://localhost:4002.

---

The source files are located in the [`src`](./src) folder. All web components are within the [`src/modules`](./src/modules) folder. The folder hierarchy also represents the naming structure of the web components.
