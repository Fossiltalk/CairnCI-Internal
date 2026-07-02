import { NAMESPACE } from "app/constants";
import { normalizeParams, parseParams } from "c/navigationUtils";
import { OmniscriptActionCommonUtil } from "c/omniscriptActionUtils";
import { setConnection } from "c/omniscriptConnection";
import { api, LightningElement } from "lwc";

const params = {
  input: {
    Bundle: "exampleExtractCases",
    DRParams: {},
  },
  options: {
    ignoreCache: false,
    useContinuation: false,
    useQueueableApexRemoting: false,
    vlcClass: `${NAMESPACE? NAMESPACE + '.' : ''}DefaultDROmniScriptIntegration`,
  },
  sClassName: `${NAMESPACE? NAMESPACE + '.' : ''}DefaultDROmniScriptIntegration`,
  sMethodName: "invokeOutboundDR",
};

export default class MyCases extends LightningElement {
  @api authenticated;
  @api connection;

  actionUtil = new OmniscriptActionCommonUtil();
  cases;
  selectedCase;
  selectedIndex;

  get params() {
    return normalizeParams(parseParams(location.search));
  }

  connectedCallback() {
    setConnection(this.connection);
    this.fetchCases();
  }

  fetchCases() {
    this.actionUtil
      .executeAction(params, null, this)
      .then((result) => {
        if (
          result.result.OBDRresp &&
          Object.keys(result.result.OBDRresp).length
        ) {
          this.cases = Array.isArray(result.result.OBDRresp)
            ? result.result.OBDRresp
            : [result.result.OBDRresp];

          this.cases = this.cases.map((item) => new CaseItem(item));
        } else if (
          result.result.OBDRresp &&
          Object.keys(result.result.OBDRresp).length === 0
        ) {
          this.cases = [];
        }
      })
      .catch((reason) => {
        console.error(reason);
      });
  }

  selectCase(evt) {
    this.deselectCase();
    try {
      this.selectedIndex = evt.currentTarget.dataset.index;
      const selectedCase = this.cases[this.selectedIndex];
      selectedCase.isSelected = true;
      this.selectedCase = { ContextId: selectedCase.Id };
    } catch (err) {
      this.selectedIndex = undefined;
      this.selectedCase = undefined;
    }
  }

  deselectCase() {
    try {
      this.cases.filter(
        (caseItem) => caseItem.isSelected
      )[0].isSelected = false;
    } catch (err) {
      console.warn(err);
    }
  }
}

class CaseItem {
  constructor(responseItem) {
    this.Id = responseItem.Id;
    this.Subject = responseItem.Subject;
    this.CreatedDate = responseItem.CreatedDate;
    this.Status = responseItem.Status;
    this.Priority = responseItem.Priority;
  }

  get isClosed() {
    return this.Status === "Closed";
  }

  get isHot() {
    return this.isClosed === false && this.Priority === "High";
  }
}
