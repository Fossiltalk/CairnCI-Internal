import { NAMESPACE } from "app/constants";
import { normalizeParams, parseParams } from "c/navigationUtils";
import { OmniscriptActionCommonUtil } from "c/omniscriptActionUtils";
import { setConnection } from "c/omniscriptConnection";
import { api } from "lwc";
import ViewRouter from "view/router";

const params = {
  input: {
    Bundle: "exampleCaseDetail",
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

export default class CaseDetail extends ViewRouter {
  @api authenticated;
  @api connection;

  actionUtil = new OmniscriptActionCommonUtil();
  comments = [];
  createdDate = "Today";
  description =
    "Lorem ipsum dolor sit amet consectetur adipisicing elit. Doloribus sit et esse officia eveniet ea, cum impedit dolore quaerat nostrum quia pariatur deleniti recusandae velit nisi. Sapiente aspernatur eos error autem recusandae dolorum qui, dolorem in a. Iste eligendi dignissimos animi perferendis dolor, possimus amet numquam voluptatum. Amet, expedita nam!";
  isLoaded = false;
  prefill = { ContextId: this.params.id };
  status = "In Progress";
  subject = "Default Subject";
  number = "012345";

  get isClosed() {
    return this.status === "Closed";
  }
  get params() {
    return normalizeParams(parseParams(location.search));
  }

  connectedCallback() {
    setConnection(this.connection);
    this.fetchCase();
  }

  fetchCase() {
    params.input.DRParams.ContextId = this.params.id;
    this.actionUtil
      .executeAction(params, null, this)
      .then((result) => {
        if (
          result.result.OBDRresp &&
          Object.keys(result.result.OBDRresp).length
        ) {
          result = result.result.OBDRresp;

          this.createdDate = result.CreatedDate;
          this.description = result.Description;
          this.status = result.Status;
          this.subject = result.Subject;
          this.number = result.Number;
          document.title += ` ${this.number}`;

          if (result.Comments && !Array.isArray(result.Comments)) {
            result.Comments = [result.Comments];
          }

          this.comments = result.Comments || [];
        }
      })
      .catch((reason) => {
        console.warn(reason);
      })
      .finally(() => (this.isLoaded = true));
  }
}
