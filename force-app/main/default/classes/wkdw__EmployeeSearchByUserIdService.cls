/*
This file is generated and isn't the actual source code for this
managed global class.
This read-only file shows the class's global constructors,
methods, variables, and properties.
To enable code to compile, all methods return null.
*/
global class EmployeeSearchByUserIdService {
    global EmployeeSearchByUserIdService() {

    }
    @InvocableMethod(label='Get Employee by User Id' description='Returns the employee record associated to the user id')
    global static List<wkdw.EmployeeSearchByUserIdService.SearchResponse> getEmployeeRecord(List<wkdw.EmployeeSearchByUserIdService.SearchRequest> input) {
        return null;
    }
global class SearchRequest {
    @InvocableVariable( required=false)
    global String userId;
    global SearchRequest() {

    }
}
global class SearchResponse {
    @InvocableVariable( required=false)
    global String email;
    @InvocableVariable( required=false)
    global String employeeId;
    @InvocableVariable( required=false)
    global String firstName;
    @InvocableVariable( required=false)
    global String lastName;
    @InvocableVariable( required=false)
    global String preferredName;
    global SearchResponse() {

    }
}
}
