import { LightningElement } from 'lwc';
import { OmniscriptBaseMixin } from "omnistudio/omniscriptBaseMixin";
import { createRecord } from 'lightning/uiRecordApi';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import pubsub from 'omnistudio/pubsub';

export default class CreateContact extends OmniscriptBaseMixin(LightningElement) {
    contactId;

    createContactRecord(event){
        console.log("createContactRecord: create contact fields: " + JSON.stringify(event.detail.fields));
        event.preventDefault();       // stop the form from submitting
        const efields = event.detail.fields;
        const fields = {};
        fields['LastName'] = efields.LastName;
        fields['FirstName'] = efields.FirstName;
        fields['MailingCity'] = efields.MailingCity;
        const recordInput = { apiName: 'Contact', fields };
        // Call createRecord UI api to create Contact Record
        createRecord(recordInput)
            .then(contact => {
                this.contactId = contact.id;
                console.log("createContactRecord: Successfull in creating contact: " + JSON.stringify(contact.id));
                // Show a toast message
                this.dispatchEvent(
                    new ShowToastEvent({
                        title: 'Success',
                        message: 'Contact created',
                        variant: 'success',
                    }),
                );
                // Fire the pub-sub event to close the flexcard modal.
                pubsub.fire("close_modal", 'close', {});
            })
            .catch(error => {
                console.log("createContactRecord: Error in createing contact: " + JSON.stringify(error.body.message));
                // Show a toast message
                this.dispatchEvent(
                    new ShowToastEvent({
                        title: 'Error creating contact record',
                        message: error.body.message,
                        variant: 'error',
                    }),
                );
                // Fire the pub-sub event to close the flexcard modal.
                pubsub.fire("close_modal", 'close', {});
            });
     }
}