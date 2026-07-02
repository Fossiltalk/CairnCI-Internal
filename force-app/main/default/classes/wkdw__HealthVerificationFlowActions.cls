/*
This file is generated and isn't the actual source code for this
managed global class.
This read-only file shows the class's global constructors,
methods, variables, and properties.
To enable code to compile, all methods return null.
*/
global class HealthVerificationFlowActions {
    global HealthVerificationFlowActions() {

    }
    @InvocableMethod(label='Create Accepted Health Verification' description='Manages all operations needed to create Accepted Health Verification')
    global static List<wkdw.HealthVerificationFlowActions.RequestOutput> createAcceptedHealthVerification(List<wkdw.HealthVerificationFlowActions.RequestInput> requestInputs) {
        return null;
    }
global class RequestInput {
    @InvocableVariable( required=false)
    global String authorizationFormTextId;
    @InvocableVariable( required=false)
    global String caseDescription;
    @InvocableVariable( required=false)
    global String caseSubject;
    @InvocableVariable( required=false)
    global String draftHealthVerificationId;
    @InvocableVariable( required=false)
    global String employeeId;
    @InvocableVariable( required=false)
    global Date healthVerificationDocumentDate;
    @InvocableVariable( required=false)
    global String healthVerificationType;
    global RequestInput() {

    }
}
global class RequestOutput {
    @InvocableVariable( required=false)
    global String caseId;
    @InvocableVariable( required=false)
    global String errorMessage;
    @InvocableVariable( required=false)
    global Boolean isSuccess;
}
}
