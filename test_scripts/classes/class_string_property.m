% Constructor writes a string property (numbl "string", double-quoted).
% The pre-pass identifies double-quoted literals as string types and
% commits the right C typedef for the property.
classdef Greeter
  properties
    msg
  end
  methods
    function obj = Greeter()
      obj.msg = "hello";
    end
    function r = greet(obj)
      r = obj.msg;
    end
  end
end

g = Greeter();
disp(g.greet());
