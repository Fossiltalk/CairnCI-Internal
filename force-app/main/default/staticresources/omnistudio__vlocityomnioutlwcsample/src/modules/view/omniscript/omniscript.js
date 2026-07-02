import { api } from "lwc";
import VlocityBaseApp from "c/vlocityBaseApp";

/**
 * Under the hood, OmniOut navigation is powered by LWC's lwc:dynamic directive, because of this
 * Attributes are required to be static. To get around this we use nested routers. This `view/omniscript` component
 * acts as an app in its self. The parent app `app/main` routes all omniscript urls to this, component.
 * This component then picks it up from there and finishes the routing.
 */
export default class OmniscriptView extends VlocityBaseApp {
  @api authenticated;
  @api connection;

  connectedCallback() {
    this.routeConfig.set("/vlocityomniscript/exampleCreateCaseEnglish", {
      title: "Create New Case",
      load: () => {
        if (!this.authenticated) return import("view/restricted");
        return import("vlocityomniscript/exampleCreateCaseEnglish");
      },
    });

    this.routeConfig.set("/vlocityomniscript/exampleCloseCaseEnglish", {
      title: "Create New Case",
      load: () => {
        if (!this.authenticated) return import("view/restricted");
        return import("vlocityomniscript/exampleCloseCaseEnglish");
      },
    });
  }
}
