% Value-semantics check: copying a class instance and mutating one
% copy must not affect the other. The numbl spec says value classes
% deep-copy on assignment.
classdef Val
  properties
    x
  end
  methods
    function obj = Val(v)
      obj.x = v;
    end
    function obj = bump(obj, k)
      obj.x = obj.x + k;
    end
  end
end

a = Val(10);
b = a.bump(5);
disp(a.x);
disp(b.x);
