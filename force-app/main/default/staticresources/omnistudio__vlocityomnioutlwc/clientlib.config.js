module.exports = {
    // default working directory (can be changed per 'cwd' in every asset option)
    context: __dirname,
    // path to the clientlib root folder (output)
    clientLibRoot: './aem.ui.apps/src/main/content/jcr_root/apps/vloclwc/clientlibs/',
    libs: [
        {
            name: 'vlocity-lwc',
            allowProxy: true,
            categories: ['aem-vlocity-lwc'],
            serializationFormat: 'xml',
            assets: {
                js: [
                    'dist/*.js',
                ]
            }
        },
        {
            name: 'vlocity-lwc-slds',
            allowProxy: true,
            categories: ['aem-vlocity-lwc-slds'],
            serializationFormat: 'xml',
            assets: {
                css: {
                    files: [
                        { src: "dist/slds/assets/styles/salesforce-lightning-design-system.min.css", dest: "/slds/assets/styles/salesforce-lightning-design-system.min.css" }
                    ]
                },
                resources: {
                    files: [
                        { src: "dist/slds/assets/icons/action/*", dest: "/slds/assets/icons/action/" },
                        { src: "dist/slds/assets/icons/action-sprite/svg/*", dest: "/slds/assets/icons/action-sprite/svg/" },
                        { src: "dist/slds/assets/icons/custom/*", dest: "/slds/assets/icons/custom/" },
                        { src: "dist/slds/assets/icons/custom-sprite/svg/*", dest: "/slds/assets/icons/custom-sprite/svg/" },
                        { src: "dist/slds/assets/icons/doctype/*", dest: "/slds/assets/icons/doctype/" },
                        { src: "dist/slds/assets/icons/doctype-sprite/svg/*", dest: "/slds/assets/icons/doctype-sprite/svg/" },
                        { src: "dist/slds/assets/icons/standard/*", dest: "/slds/assets/icons/standard/" },
                        { src: "dist/slds/assets/icons/standard-sprite/svg/*", dest: "/slds/assets/icons/standard-sprite/svg/" },
                        { src: "dist/slds/assets/icons/utility/*", dest: "/slds/assets/icons/utility/" },
                        { src: "dist/slds/assets/icons/utility-sprite/svg/*", dest: "/slds/assets/icons/utility-sprite/svg/" }
                    ]
                }
            }
        },
        {
            name: 'vlocity-lwc-nds',
            allowProxy: true,
            categories: ['aem-vlocity-lwc-nds'],
            serializationFormat: 'xml',
            assets: {
                css: {
                    files: [
                        { src: "dist/newport/assets/styles/vlocity-newport-design-system.min.css", dest: "/newport/assets/styles/vlocity-newport-design-system.min.css" }
                    ]
                },
                resources: {
                    files: [
                        { src: "dist/newport/assets/icons/action/*", dest: "/newport/assets/icons/action/" },
                        { src: "dist/newport/assets/icons/action-sprite/svg/*", dest: "/newport/assets/icons/action-sprite/svg/" },
                        { src: "dist/newport/assets/icons/custom/*", dest: "/newport/assets/icons/custom/" },
                        { src: "dist/newport/assets/icons/custom-sprite/svg/*", dest: "/newport/assets/icons/custom-sprite/svg/" },
                        { src: "dist/newport/assets/icons/doctype/*", dest: "/newport/assets/icons/doctype/" },
                        { src: "dist/newport/assets/icons/doctype-sprite/svg/*", dest: "/newport/assets/icons/doctype-sprite/svg/" },
                        { src: "dist/newport/assets/icons/standard/*", dest: "/newport/assets/icons/standard/" },
                        { src: "dist/newport/assets/icons/standard-sprite/svg/*", dest: "/newport/assets/icons/standard-sprite/svg/" },
                        { src: "dist/newport/assets/icons/utility/*", dest: "/newport/assets/icons/utility/" },
                        { src: "dist/newport/assets/icons/utility-sprite/svg/*", dest: "/newport/assets/icons/utility-sprite/svg/" }
                    ]
                }
            }
        },
        {
            name: 'aem-vlocity-vlocityresources',
            allowProxy: true,
            categories: ['aem-vlocity-lwc-vlocityresources'],
            serializationFormat: 'xml',
            assets: {
                css: {
                    files: [
                        { src: "dist/vlocityresources/slds/styles/*.css", dest: "/vlocityresources/slds/styles/" }
                    ]
                }
            }
        },
        {
            name: 'vlocity-lwc-pdf',
            allowProxy: true,
            categories: ['aem-vlocity-lwc-pdf'],
            serializationFormat: 'xml',
            assets: {
                js: [
                    'dist/vlocityresources/javascript/*.js',
                ]
            }
        },
    ]
};
