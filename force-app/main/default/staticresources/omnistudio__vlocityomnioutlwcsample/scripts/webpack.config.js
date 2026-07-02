// Custom webpack configuration file, provides generation of service worker
// More information: https://developers.google.com/web/tools/workbox/modules/workbox-webpack-plugin
const express = require('express'),
    path = require('path'),
    fs = require('fs'),
    webpack = require('webpack'),
    defaultBuilder = require('@omnistudio/resources/src/javascript/utils/webpackBuilder'),
    pkg = require('../package.json');

const componentNamespace = pkg.componentNamespace || 'cmp';
const omniscriptNamespace = pkg.omniscriptNamespace || 'vlocityomniscript';
const vertical = 'omnistudio';
let alias = {
    'vlocityoverride/redirects': path.resolve(__dirname, '../src/modules/vlocityoverride/redirects.js'),
    'vlocitytranslations/translations': path.resolve(__dirname, '../src/modules/vlocitytranslations/translations.js'),
};

// Get the installed packages
const npmBasePath = path.resolve(__dirname, '../node_modules/@omnistudio');
if (fs.existsSync(npmBasePath)) {
    const list = fs.readdirSync(npmBasePath);
    list.forEach(path => {
        const fullPath = npmBasePath + '/' + path,
            info = fs.statSync(fullPath);

        if (info.isDirectory()) {
            const packageAlias = defaultBuilder(fullPath + '/src/javascript/salesforce/');
            alias = {
                ...alias,
                ...packageAlias.resolve.alias,
            };
        }
    });
}

// Export webpack config
module.exports = {
    output: {
        publicPath: '/',
    },
    plugins: [
        new webpack.DefinePlugin({
            COMPONENT_NAMESPACE: JSON.stringify(componentNamespace),
            OMNISCRIPT_NAMESPACE: JSON.stringify(omniscriptNamespace),
            SF_ORG_NAMESPACE: JSON.stringify(process.env.SF_ORG_NAMESPACE),
            // Set to true enable navigation using the c-router, or c-omniscript-router,
            // without triggering a page reload.
            VLOCITY_SPA_NAVIGATION: false,
        }),
    ],
    devServer: {
        before: function(app, server, compiler) {
            app.use('/slds/', express.static('./node_modules/@salesforce-ux/design-system/'));
        },
        // Disable to use standard html routing
        historyApiFallback: true,
        port: 4002,
    },
    resolve: {
        symlinks: false,
        alias: alias,
        fallback: { "querystring": require.resolve("querystring-es3") }
    },
};
