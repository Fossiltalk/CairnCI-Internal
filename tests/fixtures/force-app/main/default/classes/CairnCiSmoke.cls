/**
 * Trivial Apex used only to exercise CairnCI's validate path (deploy-check,
 * RunLocalTests, coverage gate) against a real scratch org. Not a product class.
 */
public with sharing class CairnCiSmoke {
    public static Integer answer() {
        return 42;
    }
}
