import { LightningElement, wire, api, track } from 'lwc';
import getIndAppId from '@salesforce/apex/getRecordId.getIndAppId';
import getAccountId from '@salesforce/apex/getRecordId.getAccountId'

export default class InAppLanding extends LightningElement {
    @api welcome_text = "Welcome to Benefit Management Learning Home";
    @api no_record_loan_application = false;
    @api no_record_account = false;
    @api no_account = false;

    accountId;
    loanApplicationId;
    individualAppId;
    accountId;

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

        getAccountId()
        .then(result => {
            console.log("AccountId from getContactId", result);
            if (result.length) {
                this.no_account = false;
                this.accountId = result[0].Id;
            } else {
                this.no_account = true;
                this.accountId = ""
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