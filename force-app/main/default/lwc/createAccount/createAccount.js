import { LightningElement } from 'lwc';
import { OmniscriptBaseMixin } from "omnistudio/omniscriptBaseMixin";
import { createRecord } from 'lightning/uiRecordApi';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import pubsub from 'omnistudio/pubsub';

export default class CreateAccount extends OmniscriptBaseMixin(LightningElement) {
    accountId;

    createAccountRecord(event){
        console.log("createAccountRecord: createAccount: " + JSON.stringify(event.detail.fields));
        event.preventDefault();       // stop the form from submitting
        const efields = event.detail.fields;
        const fields = {};
        fields['LastName'] = efields.LastName;
        fields['FirstName'] = efields.FirstName;
        fields['ShippingCity'] = efields.ShippingCity;
        const recordInput = { apiName: 'Account', fields };
        // Call createRecord UI api to create Contact Record
        createRecord(recordInput)
            .then(account => {
                this.accountId = account.id;
                console.log("createAccountRecord: Successfull in createing Account: " + JSON.stringify(account.id));
                // Show a toast message
                this.dispatchEvent(
                    new ShowToastEvent({
                        title: 'Success',
                        message: 'Account created',
                        variant: 'success',
                    }),
                );
                // Fire the pub-sub event to close the flexcard modal.
                pubsub.fire("close_modal", 'close', {});
            })
            .catch(error => {
                console.log("createAccountRecord: Error in createing Account: " + JSON.stringify(error.body.message));
                // Show a toast message
                this.dispatchEvent(
                    new ShowToastEvent({
                        title: 'Error creating Account record',
                        message: error.body.message,
                        variant: 'error',
                    }),
                );
                // Fire the pub-sub event to close the flexcard modal.
                pubsub.fire("close_modal", 'close', {});
            });
     }
}