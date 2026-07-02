import jsforce from "jsforce";
import VlocityBaseApp from "c/vlocityBaseApp";
import { delay } from "c/asyncUtils";
import { api } from "lwc";
import {
  SF_OAUTH_CLIENT_ID,
  SF_OAUTH_CALLBACK_URL,
  NAMESPACE,
  SF_LOGIN_URL,
} from "app/constants";

/**
 * Here in our entry point, we extend the VlocityBaseApp, which provides the following convenient properties and methods.
 * @property {Map<string, RouteConfig>} routeConfig - A map of url to route config objects used by c-router,
 * pre configured with a Page Not found error handler.
 * @property {Map<url, redirect>} redirects - A empty map used by c-router. By adding entries here you can
 * customize urls that have been configured on-platform .
 * @property {Object} params - A reference to the current page search parameters in the form of an object.
 * @property {Router} router - A reference to the embedded c-router component.
 * @method routeChange - Trigger the routeChange handler on the embedded c-router component.
 * Use when url has hae happened outside of the c-router. See vloc/navMain for more details.
 */
export default class Main extends VlocityBaseApp {
  @api layout = "slds";

  /**
   * Boolean value to be passed down into child components via attributes, denoting the applications authentication state.
   * @type {boolean}
   */
  authenticated = false;

  /**
   * Wrapped jsForce Connection value to be passed down into child components via attributes.
   * Used by both view/* components and vlocityomniscript components.
   * @type {Connection}
   */

  showSpinner = false;

  constructor() {
    super();

    /**
     * Make sure to add your apps domain E.G. http://localhost:4002 to your org's CORS setup.
     */
    jsforce.browser.init({
      clientId: SF_OAUTH_CLIENT_ID,
      redirectUri: SF_OAUTH_CALLBACK_URL,
      loginUrl: SF_LOGIN_URL
    });

    jsforce.browser.on("connect", (connection) => {
      /**
       * OmniOut LWC connections require additional the additional properties
       * namespace, and request.
       */
      this.connection = {
        ...connection,
        namespace: NAMESPACE,
        request(url, data) {
          return connection.requestPost(url, data);
        },
      };
      this.authenticated = true;
      this.routeChange();
    });
  }

  connectedCallback() {
    /**
     * For each URL in your app that is available, a routConfig must be set.
     */
    this.routeConfig.set("/", {
      title: "Welcome to Vlocity OmniOut for LWC components",
      load: () => import("view/homePage"),
    });

    this.routeConfig.set("/my-cases", {
      title: "My Cases",
      load: () => {
        if (!this.authenticated) return import("view/restricted");
        return import("view/myCases");
      },
    });

    this.routeConfig.set("/case-detail", {
      title: "Case: ",
      load: () => {
        if (!this.authenticated) return import("view/restricted");
        return import("view/caseDetail");
      },
    });

    /**
     * Use wildcards to direct multiple paths to the same view.
     * view/omniscript is a nested routing component that handles all
     * vlocity omniscript routing.
     */
    this.routeConfig.set("/vlocityomniscript/*", {
      load: () => import("view/omniscript"),
    });

    /**
     * Rename routes in your application by using redirects.
     */
    this.redirects.set("/view/homePage", "/");
    this.redirects.set("/view/myCases", "/my-cases");
    this.redirects.set("/r/case", "/case-detail");
    this.redirects.set("/o/case/*", "/my-cases");
  }

  /**
   * By listening to the `routechange` event fired from navigate-actions. We can keep our
   * Navigation menu, and c-router in sync.
   */
  updateNav() {
    this.template.querySelector("app-nav-main").updateNav();
  }

  login() {
    jsforce.browser.login(null, () => {
      location.assign(location.pathname);
    });
  }

  logout() {
    jsforce.browser.logout();
    delay(500).then(() => location.assign("/"));
  }
}
