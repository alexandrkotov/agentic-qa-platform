Feature: orders-1

  @happy_path @orders-1
  Scenario: Submit DRAFT order
    Given an API request is sent for "orders-1":
      """
      {
        "method": "POST",
        "path": "/customers",
        "requestBody": {
          "email": "submit-test-{{unique}}@example.com",
          "name": "Submit Test Customer"
        }
      }
      """
    And an API request is sent for "orders-1":
      """
      {
        "method": "POST",
        "path": "/products",
        "requestBody": {
          "name": "Submit Test Product",
          "price": 15.99
        }
      }
      """
    And an API request is sent for "orders-1":
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
    When an API request is sent for "orders-1":
      """
      {
        "method": "PATCH",
        "path": "/orders/{id}/status",
        "requestBody": {
          "status": "SUBMITTED"
        }
      }
      """
    Then the "orders-1" response has this status code:
      """
      {
        "statusCode": 200
      }
      """
    And the database has this row for "orders-1":
      """
      {
        "table": "Order",
        "where": {
          "id": "{orders.id}"
        },
        "expectedFields": {
          "status": "SUBMITTED"
        }
      }
      """
    And the database has this row for "orders-1":
      """
      {
        "table": "OrderStatusHistory",
        "where": {
          "orderId": "{orders.id}",
          "status": "SUBMITTED"
        },
        "expectedFields": {
          "status": "SUBMITTED"
        }
      }
      """

  @happy_path @orders-1
  Scenario: Verify Kafka event on order creation
    Given an API request is sent for "orders-1":
      """
      {
        "method": "POST",
        "path": "/customers",
        "requestBody": {
          "email": "kafka-create-{{unique}}@example.com",
          "name": "Kafka Create Test Customer"
        }
      }
      """
    And an API request is sent for "orders-1":
      """
      {
        "method": "POST",
        "path": "/products",
        "requestBody": {
          "name": "Kafka Create Test Product",
          "price": 25
        }
      }
      """
    When an API request is sent for "orders-1":
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
    Then the "orders-1" response has this status code:
      """
      {
        "statusCode": 201
      }
      """
    And a Kafka message for "orders-1" matches this:
      """
      {
        "topic": "orders.status-changed",
        "expectedFields": {
          "orderId": "{orders.id}",
          "status": "DRAFT"
        }
      }
      """

  @happy_path @orders-1
  Scenario: Verify Kafka event on order submission
    Given an API request is sent for "orders-1":
      """
      {
        "method": "POST",
        "path": "/customers",
        "requestBody": {
          "email": "kafka-submit-{{unique}}@example.com",
          "name": "Kafka Submit Test Customer"
        }
      }
      """
    And an API request is sent for "orders-1":
      """
      {
        "method": "POST",
        "path": "/products",
        "requestBody": {
          "name": "Kafka Submit Test Product",
          "price": 30
        }
      }
      """
    And an API request is sent for "orders-1":
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
    When an API request is sent for "orders-1":
      """
      {
        "method": "PATCH",
        "path": "/orders/{id}/status",
        "requestBody": {
          "status": "SUBMITTED"
        }
      }
      """
    Then the "orders-1" response has this status code:
      """
      {
        "statusCode": 200
      }
      """
    And the database has this row for "orders-1":
      """
      {
        "table": "Order",
        "where": {
          "id": "{orders.id}"
        },
        "expectedFields": {
          "status": "SUBMITTED"
        }
      }
      """
    And a Kafka message for "orders-1" matches this:
      """
      {
        "topic": "orders.status-changed",
        "expectedFields": {
          "orderId": "{orders.id}",
          "status": "SUBMITTED"
        }
      }
      """

  @happy_path @orders-1
  Scenario: Delete DRAFT order
    # TODO (unconfirmed): Cannot verify order no longer exists in DB - no 'db_row_absent' assertion kind available
    Given an API request is sent for "orders-1":
      """
      {
        "method": "POST",
        "path": "/customers",
        "requestBody": {
          "email": "delete-draft-{{unique}}@example.com",
          "name": "Delete Draft Test Customer"
        }
      }
      """
    And an API request is sent for "orders-1":
      """
      {
        "method": "POST",
        "path": "/products",
        "requestBody": {
          "name": "Delete Draft Test Product",
          "price": 12.5
        }
      }
      """
    And an API request is sent for "orders-1":
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
    When an API request is sent for "orders-1":
      """
      {
        "method": "DELETE",
        "path": "/orders/{id}",
        "requestBody": null
      }
      """
    Then the "orders-1" response has this status code:
      """
      {
        "statusCode": 200
      }
      """

  @edge_case @orders-1
  Scenario: Attempt to delete SUBMITTED order
    Given an API request is sent for "orders-1":
      """
      {
        "method": "POST",
        "path": "/customers",
        "requestBody": {
          "email": "delete-submitted-{{unique}}@example.com",
          "name": "Delete Submitted Test Customer"
        }
      }
      """
    And an API request is sent for "orders-1":
      """
      {
        "method": "POST",
        "path": "/products",
        "requestBody": {
          "name": "Delete Submitted Test Product",
          "price": 20
        }
      }
      """
    And an API request is sent for "orders-1":
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
    And an API request is sent for "orders-1":
      """
      {
        "method": "PATCH",
        "path": "/orders/{id}/status",
        "requestBody": {
          "status": "SUBMITTED"
        }
      }
      """
    When a UI action is performed for "orders-1":
      """
      {
        "role": "button",
        "label": "Delete",
        "route": "/orders",
        "value": null,
        "scope": "{orders.id}"
      }
      """
    Then the "orders-1" UI element has this visibility:
      """
      {
        "role": "button",
        "label": "Delete",
        "visible": false,
        "scope": "{orders.id}"
      }
      """
