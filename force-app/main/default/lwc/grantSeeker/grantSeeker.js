import { LightningElement, wire, api, track } from 'lwc';
import getOrgBaseUrl from '@salesforce/apex/getRecordId.getOrgBaseUrl'
import getContactId from '@salesforce/apex/getRecordId.getContactId'

export default class InAppLanding extends LightningElement {
    @api welcome_text = "Learn how a grantseeker can view and apply to a funding opportunity";
    @api no_record_loan_application = false;
    @api no_record_account = false;
    @api no_site_url = false;
    @api no_contact = false;

    
    @api site_url1="https://${location.host}$/trialorg/s/recordlist/FundingOpportunity/Default";
    @api site_url2="https://${location.host}$/trialorg/s/individualapplication/IndividualApplication/Default";

    contactId;
    loanApplicationId;
    site_url;
    site_opp;
    site_app;

    connectedCallback() {
        getOrgBaseUrl()
        .then(result => {
            console.log("OrgBaseUrl from getOrgBaseUrl", result);
            if (result.length) {
                this.no_site_url = false;
                this.site_url = result;
                this.site_opp = "https://" + this.site_url + "/trialorg/s/recordlist/FundingOpportunity/Default";
                this.site_app = "https://" + this.site_url + "/trialorg/s/individualapplication/IndividualApplication/Defaul";
            } else {
                this.no_site_url = true;
                this.site_url = ""
            }
        })

        getContactId()
        .then(result => {
            console.log("ContactId from getContactId", result);
            if (result.length) {
                this.no_contact = false;
                this.contactId = result[0].Id;
            } else {
                this.no_contact = true;
                this.contactId = ""
            }
        })
    }
    get pass_false() {
        return false;
    }

    get pass_true() {
        return true;
    }

}