Feature: customers-2

  @happy_path @customers-2
  Scenario: Update customer information
    Given an API request is sent for "customers-2":
      """
      {
        "method": "POST",
        "path": "/customers",
        "requestBody": {
          "email": "update-test-{{unique}}@example.com",
          "name": "Original Name"
        }
      }
      """
    When an API request is sent for "customers-2":
      """
      {
        "method": "PATCH",
        "path": "/customers/{id}",
        "requestBody": {
          "name": "Updated Name",
          "email": "updated-{{unique}}@example.com"
        }
      }
      """
    Then the "customers-2" response has this status code:
      """
      {
        "statusCode": 200
      }
      """
    And the "customers-2" response body has this field:
      """
      {
        "field": "name",
        "expected": "Updated Name"
      }
      """
    And the database has this row for "customers-2":
      """
      {
        "table": "Customer",
        "where": {
          "id": "{customers.id}"
        },
        "expectedFields": {
          "name": "Updated Name"
        }
      }
      """

  @happy_path @customers-2
  Scenario: Delete customer with no orders
    Given an API request is sent for "customers-2":
      """
      {
        "method": "POST",
        "path": "/customers",
        "requestBody": {
          "email": "delete-no-orders-{{unique}}@example.com",
          "name": "Customer To Delete"
        }
      }
      """
    When an API request is sent for "customers-2":
      """
      {
        "method": "DELETE",
        "path": "/customers/{id}",
        "requestBody": null
      }
      """
    Then the "customers-2" response has this status code:
      """
      {
        "statusCode": 200
      }
      """

  @edge_case @customers-2
  Scenario: Delete customer with existing orders
    Given an API request is sent for "customers-2":
      """
      {
        "method": "POST",
        "path": "/customers",
        "requestBody": {
          "email": "customer-with-order-{{unique}}@example.com",
          "name": "Customer With Order"
        }
      }
      """
    And an API request is sent for "customers-2":
      """
      {
        "method": "POST",
        "path": "/products",
        "requestBody": {
          "name": "Product For Order {{unique}}",
          "price": 10
        }
      }
      """
    And an API request is sent for "customers-2":
      """
      {
        "method": "POST",
        "path": "/orders",
        "requestBody": {
          "customerId": "{customers.id}",
          "items": [
            {
              "productId": "{products.id}",
              "quantity": 1
            }
          ]
        }
      }
      """
    When an API request is sent for "customers-2":
      """
      {
        "method": "DELETE",
        "path": "/customers/{id}",
        "requestBody": null
      }
      """
    Then the "customers-2" response has this status code:
      """
      {
        "statusCode": 409
      }
      """
    And the "customers-2" response matches this error message:
      """
      {
        "matches": "Cannot delete customer {customers.id}: they have 1 order(s)"
      }
      """
