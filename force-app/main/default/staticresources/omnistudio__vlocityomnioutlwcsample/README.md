# Vlocity OmniOut for LWC - Sample app

This sample app shows how you can: Setup a basic jsForce connection, create an LWC Single Page Application (SPA) complete with component routing your OmniOut project by leveraging the `c-router` and `c-omniscript-router` components, and interact with on-platform DataRaptors from a custom LWC.

## How to start?

1. Update the authentication key field located in the `.npmrc` with the NPM repository access key from your Vlocity customer representative.
2. Run `npm install`. This will install all dependencies.
3. Update the `./src/modules/app/constants/constants.js` with the details of your connected app, and the namespace of your organization. (To use the jsForce configuration in this project, ensure that your connected app has "Require Secret for Web Server Flow" disabled.)
4. Under the `./scripts/webpack.config.js` file, update the value of `VLOCITY_SPA_NAVIGATION` to true. (This will enable navigation without page refresh.)
5. Download the static resource `vlocityomnioutlwcsample_resources` and  import the `omnioutlwcsample_datapack.json` to your connected org. Using the import button on either OmniScript Designer, Or DataRaptor Designer Page.
6. Run `npm run watch`. This will start the project with a local development server on your local address `http://localhost:4002`.

The source files are located in the [`src`](./src) folder. All web components are within the [`src/modules`](./src/modules) folder. The folder hierarchy also represents the naming structure of the web components.
