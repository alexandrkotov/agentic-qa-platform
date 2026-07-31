Feature: customers-1

  @happy_path @customers-1
  Scenario: Create Customer with valid data
    When an API request is sent for "customers-1":
      """
      {
        "method": "POST",
        "path": "/customers",
        "requestBody": {
          "email": "valid-customer-{{unique}}@example.com",
          "name": "Valid Customer"
        }
      }
      """
    Then the "customers-1" response has this status code:
      """
      {
        "statusCode": 201
      }
      """
    And the "customers-1" response body has this field:
      """
      {
        "field": "email",
        "expected": "valid-customer-{{unique}}@example.com"
      }
      """
    And the "customers-1" response body has this field:
      """
      {
        "field": "name",
        "expected": "Valid Customer"
      }
      """
    And the database has this row for "customers-1":
      """
      {
        "table": "Customer",
        "where": {
          "id": "{customers.id}"
        },
        "expectedFields": {
          "email": "valid-customer-{{unique}}@example.com",
          "name": "Valid Customer"
        }
      }
      """

  @edge_case @customers-1
  Scenario: Create Customer with missing email
    When an API request is sent for "customers-1":
      """
      {
        "method": "POST",
        "path": "/customers",
        "requestBody": {
          "name": "No Email Customer"
        }
      }
      """
    Then the "customers-1" response has this status code:
      """
      {
        "statusCode": 400
      }
      """

  @edge_case @customers-1
  Scenario: Create Customer with missing name
    When an API request is sent for "customers-1":
      """
      {
        "method": "POST",
        "path": "/customers",
        "requestBody": {
          "email": "missing-name-{{unique}}@example.com"
        }
      }
      """
    Then the "customers-1" response has this status code:
      """
      {
        "statusCode": 400
      }
      """

  @edge_case @customers-1
  Scenario: Create Customer with duplicate email
    # TODO (unconfirmed): Report does not explicitly confirm 409 for duplicate email; behavior may differ (could be 400 or allow duplicates)
    Given an API request is sent for "customers-1":
      """
      {
        "method": "POST",
        "path": "/customers",
        "requestBody": {
          "email": "duplicate-{{unique}}@example.com",
          "name": "First Customer"
        }
      }
      """
    When an API request is sent for "customers-1":
      """
      {
        "method": "POST",
        "path": "/customers",
        "requestBody": {
          "email": "duplicate-{{unique}}@example.com",
          "name": "Second Customer"
        }
      }
      """
    Then the "customers-1" response has this status code:
      """
      {
        "statusCode": 409
      }
      """
