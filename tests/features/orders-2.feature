Feature: orders-2

  @happy_path @orders-2
  Scenario: Edit DRAFT order items
    Given an API request is sent for "orders-2":
      """
      {
        "method": "POST",
        "path": "/customers",
        "requestBody": {
          "email": "edit-draft-{{unique}}@example.com",
          "name": "Edit Draft Customer"
        }
      }
      """
    And an API request is sent for "orders-2":
      """
      {
        "method": "POST",
        "path": "/products",
        "requestBody": {
          "name": "Edit Draft Product",
          "price": 15
        }
      }
      """
    And an API request is sent for "orders-2":
      """
      {
        "method": "POST",
        "path": "/products",
        "requestBody": {
          "name": "Edit Draft Product 2",
          "price": 25
        }
      }
      """
    And an API request is sent for "orders-2":
      """
      {
        "method": "POST",
        "path": "/orders",
        "requestBody": {
          "customerId": "{customers.id}",
          "items": [
            {
              "productId": "{products[0].id}",
              "quantity": 1
            }
          ]
        }
      }
      """
    When an API request is sent for "orders-2":
      """
      {
        "method": "PATCH",
        "path": "/orders/{id}/items",
        "requestBody": {
          "items": [
            {
              "productId": "{products[1].id}",
              "quantity": 3
            }
          ]
        }
      }
      """
    Then the "orders-2" response has this status code:
      """
      {
        "statusCode": 200
      }
      """
    And the database has this row for "orders-2":
      """
      {
        "table": "OrderItem",
        "where": {
          "orderId": "{orders.id}"
        },
        "expectedFields": {
          "productId": "{products[1].id}",
          "quantity": 3
        }
      }
      """

  @edge_case @orders-2
  Scenario: Attempt to edit SUBMITTED order
    Given an API request is sent for "orders-2":
      """
      {
        "method": "POST",
        "path": "/customers",
        "requestBody": {
          "email": "edit-submitted-{{unique}}@example.com",
          "name": "Edit Submitted Customer"
        }
      }
      """
    And an API request is sent for "orders-2":
      """
      {
        "method": "POST",
        "path": "/products",
        "requestBody": {
          "name": "Edit Submitted Product",
          "price": 20
        }
      }
      """
    And an API request is sent for "orders-2":
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
    And an API request is sent for "orders-2":
      """
      {
        "method": "PATCH",
        "path": "/orders/{id}/status",
        "requestBody": {
          "status": "SUBMITTED"
        }
      }
      """
    When an API request is sent for "orders-2":
      """
      {
        "method": "PATCH",
        "path": "/orders/{id}/items",
        "requestBody": {
          "items": [
            {
              "productId": "{products.id}",
              "quantity": 5
            }
          ]
        }
      }
      """
    Then the "orders-2" response has this status code:
      """
      {
        "statusCode": 409
      }
      """

  @happy_path @orders-2
  Scenario: Create order with quantity greater than 1
    Given an API request is sent for "orders-2":
      """
      {
        "method": "POST",
        "path": "/customers",
        "requestBody": {
          "email": "qty-test-{{unique}}@example.com",
          "name": "Quantity Test Customer"
        }
      }
      """
    And an API request is sent for "orders-2":
      """
      {
        "method": "POST",
        "path": "/products",
        "requestBody": {
          "name": "Quantity Test Product",
          "price": 10.5
        }
      }
      """
    When an API request is sent for "orders-2":
      """
      {
        "method": "POST",
        "path": "/orders",
        "requestBody": {
          "customerId": "{customers.id}",
          "items": [
            {
              "productId": "{products.id}",
              "quantity": 5
            }
          ]
        }
      }
      """
    Then the "orders-2" response has this status code:
      """
      {
        "statusCode": 201
      }
      """
    And the "orders-2" response body has this field:
      """
      {
        "field": "status",
        "expected": "DRAFT"
      }
      """
    And the database has this row for "orders-2":
      """
      {
        "table": "OrderItem",
        "where": {
          "orderId": "{orders.id}"
        },
        "expectedFields": {
          "quantity": 5,
          "unitPrice": "10.50"
        }
      }
      """

  @edge_case @orders-2
  Scenario: API: Update order status with invalid status value
    Given an API request is sent for "orders-2":
      """
      {
        "method": "POST",
        "path": "/customers",
        "requestBody": {
          "email": "invalid-status-{{unique}}@example.com",
          "name": "Invalid Status Customer"
        }
      }
      """
    And an API request is sent for "orders-2":
      """
      {
        "method": "POST",
        "path": "/products",
        "requestBody": {
          "name": "Invalid Status Product",
          "price": 12
        }
      }
      """
    And an API request is sent for "orders-2":
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
    When an API request is sent for "orders-2":
      """
      {
        "method": "PATCH",
        "path": "/orders/{id}/status",
        "requestBody": {
          "status": "CANCELLED"
        }
      }
      """
    Then the "orders-2" response has this status code:
      """
      {
        "statusCode": 400
      }
      """

  @happy_path @orders-2
  Scenario: Create Order with valid customer and items
    Given an API request is sent for "orders-2":
      """
      {
        "method": "POST",
        "path": "/customers",
        "requestBody": {
          "email": "valid-order-{{unique}}@example.com",
          "name": "Valid Order Customer"
        }
      }
      """
    And an API request is sent for "orders-2":
      """
      {
        "method": "POST",
        "path": "/products",
        "requestBody": {
          "name": "Valid Order Product",
          "price": 29.99
        }
      }
      """
    When an API request is sent for "orders-2":
      """
      {
        "method": "POST",
        "path": "/orders",
        "requestBody": {
          "customerId": "{customers.id}",
          "items": [
            {
              "productId": "{products.id}",
              "quantity": 2
            }
          ]
        }
      }
      """
    Then the "orders-2" response has this status code:
      """
      {
        "statusCode": 201
      }
      """
    And the "orders-2" response body has this field:
      """
      {
        "field": "status",
        "expected": "DRAFT"
      }
      """
    And the database has this row for "orders-2":
      """
      {
        "table": "Order",
        "where": {
          "id": "{orders.id}"
        },
        "expectedFields": {
          "status": "DRAFT",
          "customerId": "{customers.id}"
        }
      }
      """
    And the database has this row for "orders-2":
      """
      {
        "table": "OrderStatusHistory",
        "where": {
          "orderId": "{orders.id}"
        },
        "expectedFields": {
          "status": "DRAFT"
        }
      }
      """
    And a Kafka message for "orders-2" matches this:
      """
      {
        "topic": "orders.status-changed",
        "expectedFields": {
          "orderId": "{orders.id}",
          "status": "DRAFT"
        }
      }
      """
