Feature: security

  @security @security
  Scenario: SQL Injection in customer email
    When an API request is sent for "security":
      """
      {
        "method": "POST",
        "path": "/customers",
        "requestBody": {
          "email": "test-{{unique}}@example.com'; DROP TABLE Customer; --",
          "name": "SQL Injection Test"
        }
      }
      """
    Then the "security" response has this status code:
      """
      {
        "statusCode": 201
      }
      """
    And the database has this row for "security":
      """
      {
        "table": "Customer",
        "where": {
          "id": "{customers.id}"
        },
        "expectedFields": {
          "email": "test-{{unique}}@example.com'; DROP TABLE Customer; --"
        }
      }
      """

  @security @security
  Scenario: XSS in product name
    # TODO (unconfirmed): Cannot verify UI escaping via API-only assertions; manual review of /products page rendering recommended to confirm script tags are escaped not executed
    When an API request is sent for "security":
      """
      {
        "method": "POST",
        "path": "/products",
        "requestBody": {
          "name": "<script>alert('XSS-{{unique}}')</script>",
          "price": 9.99
        }
      }
      """
    Then the "security" response has this status code:
      """
      {
        "statusCode": 201
      }
      """
    And the database has this row for "security":
      """
      {
        "table": "Product",
        "where": {
          "id": "{products.id}"
        },
        "expectedFields": {
          "name": "<script>alert('XSS-{{unique}}')</script>"
        }
      }
      """
