% Tiny value class: instantiate, read a property the constructor set,
% verify the property survives across an assignment chain.
classdef SimpleVal
  properties
    x
  end
  methods
    function obj = SimpleVal(v)
      obj.x = v;
    end
  end
end

c = SimpleVal(42);
disp(c.x);
