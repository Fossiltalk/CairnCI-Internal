import '@lwc/synthetic-shadow';

/**
 * The following lines allows you to customize OmniOut settings.
 */
// import { setSldsResourcesUrl, setNewportResourcesUrl } from 'c/salesforceUtils';     // <-- uncomment this line if deploying to AEM
// import { setOmniOutUsesGuestUser } from 'c/omniscriptRestApi';                       // <-- uncomment this line if your integration uses is a "Guest User"

/**
 * Here you can import the component(s) that you will export as Web Component.
 * You can import one or more components using the format `namespace/component`.
 */
import VlocApp from 'vlocityomniscript/typeExampleSubtypeExampleEnglish';

/**
 * If your OmniScript support multiple languages, you will need to include the language
 * locale for date support. For example:
 * 
 * import es from 'dayjs/locale/es';
 * import ru from 'dayjs/locale/ru';
*/
// Import any date locale here

/**
 * If your OmniScript will be deployed to AEM or you have a custom path on
 * your webserver, you will need to uncomment and/or customize the path for
 * the SLDS and Newport styles.
 */
// setSldsResourcesUrl('/etc.clientlibs/vloclwc/clientlibs/vlocity-lwc-slds/resources/slds/assets/');
// setNewportResourcesUrl('/etc.clientlibs/vloclwc/clientlibs/vlocity-lwc-nds/resources/newport/assets/');

/**
 * If your integration user is a "Guest User" and your components are configured with
 * run-mode="localScriptDef", you will need to manually set the guest user configuration
 * using the below example:
*/
// setOmniOutUsesGuestUser(true);

const availableFeature = detectFeatures();
const isCompatibleBrowser = Object.keys(availableFeature).some(
    feature => !availableFeature[feature]
);

if (isCompatibleBrowser) {
    unsupportedErrorMessage(availableFeature);
} else {
    /**
     * Here you can define the components that will be exported as Web Components.
     * This example  uses the component located in `vlocityomniscript/typeExampleSubtypeExampleEnglish`
     * and exports the component by following the LWC naming convention.
     */
    if (!customElements.get('vlocityomniscript-type-example-subtype-example-english')) {
        customElements.define('vlocityomniscript-type-example-subtype-example-english', VlocApp.CustomElementConstructor);
    }
}

function detectFeatures() {
    return {
        'Service Worker': 'serviceWorker' in navigator
    };
}

function unsupportedErrorMessage() {
    const { outdated } = window;
    outdated.style.display = 'unset';

    let message = `This browser doesn't support all the required features`;

    message += `<ul>`;
    for (const [name, available] of Object.entries(availableFeature)) {
        message += `<li><b>${name}:<b> ${available ? '✅' : '❌'}</li>`;
    }
    message += `</ul>`;

    // eslint-disable-next-line @lwc/lwc/no-inner-html
    outdated.querySelector('.unsupported_message').innerHTML = message;
}
