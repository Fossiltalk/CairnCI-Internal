import { LightningElement, wire, api, track } from 'lwc';
import getIndAppId from '@salesforce/apex/getRecordId.getIndAppId';

export default class InAppLanding extends LightningElement {
    @api welcome_text = "Learn how a grantmanager can view, review and manage applications";
    @api no_record_loan_application = false;
    @api no_record_account = false;
    @api no_individual_app = false;

    accountId;
    loanApplicationId;
    individualAppId;

    connectedCallback() {
        getIndAppId()
        .then(result => {
            console.log("Individual Application ID", result);
            if (result.length) {
                this.no_individual_app = false;
                this.individualAppId = result[0].Id;
            } else {
                this.no_individual_app = true;
                this.individualAppId = ""
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